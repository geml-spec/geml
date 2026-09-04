#!/usr/bin/env node
// PostToolUse hook — auto-version GEML edits.
//
// After the agent edits a `*.geml` file (Edit/Write), snapshot it into its
// `.gemlhistory` sidecar via `geml history save`, so every edit step is
// retained and any block can later be rolled back (`geml revert <file> #id`).
// This is what makes "addressable + versioned" real for agent editing without
// relying on the agent to remember to commit each step.
//
// Contract: reads the hook payload as JSON on stdin, NEVER blocks the tool
// (always exits 0), and is a silent no-op for anything that isn't an existing
// `.geml` file. On a commit failure it prints one line to stderr and moves on.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

// Config docs under a .claude directory (this repo's or ~/.claude) carry NO
// .gemlhistory: git already versions the project ones, and people installing
// the config must not receive — or start growing — sidecar files. The one
// exception is .claude/worktrees/: a worktree is a whole checkout, and spec
// docs edited there must keep their snapshots like anywhere else.
if (/[\\/]\.claude[\\/](?!worktrees[\\/])/.test(file)) process.exit(0);


// Documents that deliberately carry NO sidecar.
//
// A translation projection is DERIVED — it is a `=== meta` and a few `embed`
// blocks, and its content history is the source document's. Snapshotting it
// records nothing the source has not already recorded, so any document
// declaring `geml-translator/v1` is skipped by rule rather than by name.
//
// The named list is for sources whose history was retired deliberately: the
// COMPARISON pair. `spec/in_geml_format/GEML-spec.geml` is NOT here — the EN
// dogfood copy keeps its snapshots.
// `playground/` is the other kind: those documents are DEMOS, edited to show a
// feature rather than maintained as a record, and nothing reads their sidecars.
// Without this line the hook grew `playground/sample.gemlhistory` back on the
// next edit, which is how it existed in the first place.
const NO_HISTORY = [
  "docs/comparisons/COMPARISON.geml",
  "docs/comparisons/COMPARISON_CN.geml",
  "spec/in_geml_format/GEML-spec_CN.geml",
];
if (/(^|\/)playground\//.test(file.replace(/\\/g, "/"))) process.exit(0);
const posix = file.replace(/\\/g, "/");
if (NO_HISTORY.some((p) => posix === p || posix.endsWith("/" + p))) process.exit(0);
try {
  // Only the head is read: `=== meta` is the first block a projection carries.
  const head = readFileSync(file, "utf8").slice(0, 2048);
  if (/^\s*profile\s*=\s*"[^"]*geml-translator\//m.test(head)) process.exit(0);
} catch { /* unreadable: fall through and let `history save` report it */ }

const args = ["history", "save", file, "-m", `auto: ${tool ?? "edit"}`];

// Prefer this repo's built CLI (dogfood, and no PATH/shim quirks); otherwise a
// globally installed `geml`. `file` is absolute, so the working directory is
// irrelevant — the sidecar is always written next to the edited file.
const localCli = join(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."), "geml-parser", "dist", "geml.js");
// Never feed `file` (a crafted `.geml` name — Windows permits ; & ^ ( ) in
// filenames) through a shell. POSIX execs the binary directly (shell:false);
// win32 needs cmd.exe for the geml.cmd shim, so pass a command line with EACH
// token double-quoted (cmd treats metacharacters inside quotes as literal;
// Windows filenames cannot contain a ").
const r = existsSync(localCli)
  ? spawnSync(process.execPath, [localCli, ...args], { encoding: "utf8" })
  : process.platform === "win32"
    ? spawnSync(["geml", ...args].map((a) => `"${String(a).replace(/"/g, '""')}"`).join(" "), { encoding: "utf8", shell: true })
    : spawnSync("geml", args, { encoding: "utf8", shell: false });

if (r.status !== 0) {
  const why = (r.stderr || r.error?.message || "commit failed").toString().trim();
  process.stderr.write(`[geml autocommit] skipped ${file}: ${why}\n`);
}
process.exit(0);
