#!/usr/bin/env node
// logseq-sync — a Logseq DB graph ➔ a Git-friendly folder of readable GEML files.
// The full usage is the USAGE constant below, printed by `logseq-sync --help`.

import { execFileSync } from "node:child_process";
import {
  readFileSync, unlinkSync, existsSync, statSync, mkdirSync, readdirSync, watch,
} from "node:fs";
import { join, resolve, dirname, basename, sep } from "node:path";
import { tmpdir, homedir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { syncEdnToDisk, syncDiskToEdn, atomicWriteFileSync, detectExternalEdits } from "../../core/src/sync-engine.mjs";
import { ednToGemlFiles } from "../../core/src/mapping.mjs";
import { STATUS_FILE } from "../../core/src/bridge.mjs";
import { parse as parseGeml, addressedUnits, sliceUnit } from "@geml/geml";

// The engine takes the parser injected, so core keeps its single dependency.
const gemlLib = { parse: parseGeml, addressedUnits, sliceUnit };
import {
  PLUGIN_ID, logseqDotDir, logseqRootDir, signalFilePath, pluginSettings,
  findAppCli, appCliCandidates, detectGraph, detectGraphViaCli, parseManagedShim,
} from "../../core/src/discovery.mjs";

const PLUGIN_TITLE = "Sync Vault with GEML";

const USAGE = `logseq-sync — a Logseq DB graph ➔ a Git-friendly folder of readable GEML files.

Usage:
  logseq-sync [vault-dir] [flags]          vault-dir defaults to the plugin's setting
  logseq-sync <graph> <vault-dir> [flags]  explicit form, when you have several graphs
  logseq-sync doctor                       report what was detected and what is missing
  logseq-sync restore [vault-dir]          vault ➔ graph. Rehearses; --yes performs it,
                                         taking a graph backup first (--no-backup to skip)

Whatever can be worked out, is: the CLI that ships inside the desktop app,
which graph the app currently has open, where the plugin's signal file lives,
and where you told the plugin to put the vault. Every one of them has a flag
to override it.

Flags:
  --once                 Sync once and exit (default: keep watching)
  --two-way              Also import vault edits back into the graph, checked
                         on every cycle. A file changed on BOTH sides is a
                         conflict: neither imported nor overwritten, reported
                         until you merge it. Deletions are never imported.
                         Takes a graph backup before the first import and
                         every 10th after. Needs the app CLI.
  --git-commit           Commit, creating the vault repository if there is none
                         (default: commit only when the vault ALREADY is a repository)
  --no-git-commit        Never touch git
  --mirror               Delete vault files for pages removed from the graph
                         (default: keep them, and report the divergence)
  --overwrite-unmanaged  Overwrite files that were already there when the sync
                         first ran (default: hold them and name them — a file
                         no manifest claims was written by someone else)
  --markdown <dir>       Also write the graph there as an OG (file-version)
                         Logseq graph: bullets, id:: lines, ((uuid)) refs — a
                         directory the old app opens. Lossy and one-way
                         (properties, tags and data blocks have no OG shape);
                         the GEML tree stays the one that round-trips, and
                         restore never reads this.
  --graph <name>         Graph to export (default: the one the app has open)
  --app-cli <path>       The desktop app's CLI (default: found on PATH, or the app bundle)
  --no-app-cli           Force the @logseq/cli fallback, which cannot read an open graph
  --signal <file>        Plugin bridge file (default: found in the plugin's storage dir)
  --no-signal            Ignore the bridge; poll on the interval only
  --interval <seconds>   Poll interval for watch mode (positive integer, default: 10)
  --message <text>       Custom git commit message
  --api-server-token <token>
                         Route the @logseq/cli fallback through the app's HTTP API
                         server. Prefer LOGSEQ_API_SERVER_TOKEN — a token in argv is
                         readable by every process on the machine via \`ps\`.
  --help, -h             This text`;

const args = process.argv.slice(2);
const positional = [];
const flags = {
  once: false,
  twoWay: false,
  gitCommit: "auto",
  mirror: false,
  overwriteUnmanaged: false,
  markdown: null,
  yes: false,
  backup: true,
  interval: 10,
  message: null,
  signal: undefined,   // undefined = auto, null = disabled, string = explicit
  appCli: undefined,   // undefined = auto, null = disabled, string = explicit
  apiServerToken: null,
  graph: null,
};

function needValue(i, name) {
  if (i + 1 >= args.length) {
    console.error(`Error: ${name} requires a value.`);
    process.exit(2);
  }
}

let subcommand = null;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--help" || arg === "-h" || (subcommand === null && positional.length === 0 && arg === "help")) {
    console.log(USAGE);
    process.exit(0);
  } else if (arg === "--watch") {
    // Watch is the default now; the flag stays so old command lines keep working.
  } else if (arg === "--once") {
    flags.once = true;
  } else if (arg === "--git-commit") {
    flags.gitCommit = true;
  } else if (arg === "--no-git-commit") {
    flags.gitCommit = false;
  } else if (arg === "--yes") {
    flags.yes = true;
  } else if (arg === "--no-backup") {
    flags.backup = false;
  } else if (arg === "--two-way") {
    flags.twoWay = true;
  } else if (arg === "--mirror") {
    flags.mirror = true;
  } else if (arg === "--overwrite-unmanaged") {
    flags.overwriteUnmanaged = true;
  } else if (arg === "--markdown") {
    needValue(i, "--markdown");
    flags.markdown = args[++i];
  } else if (arg === "--no-signal") {
    flags.signal = null;
  } else if (arg === "--no-app-cli") {
    flags.appCli = null;
  } else if (arg === "--interval") {
    needValue(i, "--interval");
    const rawVal = args[++i];
    const val = Number(rawVal);
    if (!Number.isInteger(val) || val <= 0) {
      console.error(`Error: --interval must be a positive integer >= 1 (got "${rawVal}").`);
      process.exit(2);
    }
    flags.interval = val;
  } else if (arg === "--message") {
    needValue(i, "--message");
    flags.message = args[++i];
  } else if (arg === "--signal") {
    needValue(i, "--signal");
    flags.signal = args[++i];
  } else if (arg === "--app-cli") {
    needValue(i, "--app-cli");
    flags.appCli = args[++i];
  } else if (arg === "--graph") {
    needValue(i, "--graph");
    flags.graph = args[++i];
  } else if (arg === "--api-server-token") {
    needValue(i, "--api-server-token");
    flags.apiServerToken = args[++i];
  } else if (arg.startsWith("-")) {
    // One dash included: "-graph demo" once sailed through as a graph literally
    // named "-graph" and a vault named "demo" — a typo must stop, not sync.
    console.error(`Error: Unknown flag "${arg}". Run \`logseq-sync --help\` for usage.`);
    process.exit(2);
  } else if (subcommand === null && positional.length === 0 && (arg === "doctor" || arg === "restore")) {
    subcommand = arg;
  } else {
    positional.push(arg);
  }
}

const probe = {
  platform: process.platform,
  env: process.env,
  home: process.env.HOME || process.env.USERPROFILE || homedir(),
  exists: existsSync,
  read: (p) => readFileSync(p, "utf8"),
  listDir: (p) => {
    try {
      return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return [];
    }
  },
};

const settings = pluginSettings(probe);

// A shell expands ~ before the watcher ever sees it; a text field in Logseq's
// settings panel does not, and resolve("~/vault") would quietly create a
// directory literally named "~" beside the working directory.
function expandHome(p) {
  if (!p) return p;
  if (p === "~") return probe.home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(probe.home, p.slice(2));
  return p;
}

// --- how to export --------------------------------------------------------
const apiServerToken = (flags.apiServerToken || process.env.LOGSEQ_API_SERVER_TOKEN || "").trim() || null;

function resolveAppCli() {
  if (flags.appCli === null) return null;                       // --no-app-cli
  const explicit = flags.appCli || (process.env.LOGSEQ_APP_CLI || "").trim() || null;
  if (explicit) {
    if (/\.(cmd|bat)$/i.test(explicit)) {
      // If it is the launcher the app generated, read the paths out of it
      // rather than refusing something that is perfectly usable.
      const parsed = parseManagedShim(probe, explicit);
      if (parsed) {
        if (apiServerToken) {
          console.error(
            "Error: --app-cli and --api-server-token are mutually exclusive — the app CLI reaches the running app directly, so it needs no token."
          );
          process.exit(2);
        }
        return parsed;
      }
      console.error(
        `Error: --app-cli "${explicit}" is a .cmd/.bat shim; Node cannot run one without a shell. ` +
          `Point --app-cli at the Logseq executable itself.`
      );
      process.exit(2);
    }
    if (apiServerToken) {
      console.error(
        "Error: --app-cli and --api-server-token are mutually exclusive — the app CLI reaches the running app directly, so it needs no token."
      );
      process.exit(2);
    }
    return { command: explicit, argsPrefix: [], env: {}, how: "given with --app-cli" };
  }
  // Auto-detection happens at the call site, where a candidate can be verified
  // by actually using it. An explicit token selects the fallback transport, so
  // there is nothing to detect.
  return null;
}

function runVia(candidate, cmdArgs) {
  return execFileSync(candidate.command, [...candidate.argsPrefix, ...cmdArgs], {
    encoding: "utf8",
    shell: false,
    maxBuffer: 1 << 24,
    env: { ...process.env, ...candidate.env },
  });
}

// Finding the CLI and asking it which graph to sync are the same step: a
// candidate that answers `graph list` is, by that fact, the working one. So we
// verify by doing the work rather than by trusting a path — which is the only
// honest way to behave on an OS or Logseq version this has never run on. The
// filesystem heuristics stay as the fallback for when there is no CLI at all.
let appCli = resolveAppCli();
let detected = null;

if (appCli) {
  detected = detectGraphViaCli((cmdArgs) => runVia(appCli, cmdArgs));
} else if (flags.appCli !== null && !apiServerToken) {
  const candidates = appCliCandidates(probe);
  for (const candidate of candidates) {
    const answer = detectGraphViaCli((cmdArgs) => runVia(candidate, cmdArgs));
    if (answer) {
      appCli = candidate;
      detected = answer;
      break;
    }
  }
  // None answered: keep the best-ranked one anyway, so the export fails with
  // that CLI's own error instead of a vague "no CLI found".
  if (!appCli) appCli = candidates[0] ?? null;
}

if (!detected) detected = detectGraph(probe);
const knownGraphs = detected?.graphs ?? [];
let graphName = flags.graph;
let vaultRaw = null;

if (positional.length >= 2) {
  if (!graphName) graphName = positional[0];
  vaultRaw = positional[1];
} else if (positional.length === 1) {
  const only = positional[0];
  const looksLikePath = only.includes("/") || only.includes(sep) || only.startsWith(".") || only.startsWith("~");
  const isGraphName =
    !looksLikePath &&
    (detected?.name === only || (detected?.candidates ?? []).includes(only));
  if (isGraphName) {
    console.error(
      `Error: "${only}" is the name of a graph, not a vault directory. ` +
        `Write the destination too — logseq-sync ${only} <vault-dir> — or select it with --graph ${only}.`
    );
    process.exit(2);
  }
  vaultRaw = only;
} else {
  vaultRaw = settings.vaultPath || null;
}

function resolveGraphOrExit() {
  if (graphName) return graphName;
  if (detected?.name) return detected.name;
  if (detected?.candidates) {
    console.error(
      `Error: several graphs and none open in the app — ${detected.candidates.join(", ")}. ` +
        `Pick one with --graph <name>. Run \`logseq-sync doctor\` for the full picture.`
    );
    process.exit(2);
  }
  console.error(
    `Error: no Logseq graphs found under ${join(logseqRootDir(probe), "graphs")}. ` +
      `Open a graph in Logseq first. Run \`logseq-sync doctor\` for the full picture.`
  );
  process.exit(2);
}

function resolveVaultOrExit() {
  if (vaultRaw) return resolve(expandHome(vaultRaw));
  console.error(
    `Error: no vault directory. Set it in Logseq — Settings → Plugins → ${PLUGIN_TITLE} → ` +
      `"Vault folder" — or pass one: logseq-sync <vault-dir>. ` +
      `Run \`logseq-sync doctor\` for the full picture.`
  );
  process.exit(2);
}



function resolveSignalPath() {
  if (flags.signal === null) return null;                       // --no-signal
  if (typeof flags.signal === "string") return resolve(expandHome(flags.signal));
  const auto = signalFilePath(probe);
  // The storage directory only appears once the plugin has written something,
  // so its absence proves nothing. Gate on the dotdir instead: if Logseq is
  // installed at all, writing status there is right — and it is already there
  // for the plugin to read the moment it loads.
  return existsSync(logseqDotDir(probe)) ? auto : null;
}

function redact(text) {
  const str = String(text ?? "");
  return apiServerToken ? str.split(apiServerToken).join("***") : str;
}

// --- doctor ---------------------------------------------------------------
function doctor() {
  const dotDir = logseqDotDir(probe);
  const rows = [];
  let blocked = false;

  const mark = (ok, label, detail) => {
    rows.push(`${ok ? "  ok  " : " MISS "} ${label.padEnd(14)} ${detail}`);
    if (!ok) blocked = true;
  };

  mark(existsSync(dotDir), "Logseq dotdir", dotDir);

  const storage = join(dotDir, "storages", PLUGIN_ID);
  const pluginInstalled = existsSync(storage);
  rows.push(
    `${pluginInstalled ? "  ok  " : " note " } ${"plugin".padEnd(14)} ` +
      (pluginInstalled
        ? storage
        : `not installed yet (no ${storage}) — sync still works, the toolbar just will not update`)
  );

  if (appCli) {
    mark(true, "app CLI", `${appCli.command} (${appCli.how})`);
  } else if (apiServerToken) {
    rows.push(`  ok   ${"export".padEnd(14)} @logseq/cli through the app's API server`);
  } else {
    mark(false, "app CLI", "no Logseq CLI found on PATH or in the app bundle — install Logseq, or pass --app-cli <path>");
  }

  if (graphName) mark(true, "graph", `${graphName} (given)`);
  else if (detected?.name) mark(true, "graph", `${detected.name} (${detected.how})`);
  else if (detected?.candidates) mark(false, "graph", `ambiguous: ${detected.candidates.join(", ")} — pick one with --graph`);
  else mark(false, "graph", `none found under ${join(logseqRootDir(probe), "graphs")}`);

  if (vaultRaw) mark(true, "vault", resolve(expandHome(vaultRaw)));
  else mark(false, "vault", `unset — Settings → Plugins → ${PLUGIN_TITLE} → "Vault folder", or pass one as an argument`);

  // Only a run that will actually commit needs an author.
  const wouldCommit =
    flags.gitCommit === true ||
    (flags.gitCommit !== false && vaultRaw && existsSync(resolve(expandHome(vaultRaw))) && isGitRepo(resolve(expandHome(vaultRaw))));
  if (wouldCommit) {
    try {
      // Probe where the commit will actually run: identity can come from the
      // vault's own repo config, and asking from anywhere else (say, a source
      // checkout that has one) answers a different question.
      const where = vaultRaw && existsSync(resolve(expandHome(vaultRaw))) ? resolve(expandHome(vaultRaw)) : tmpdir();
      execFileSync("git", ["var", "GIT_AUTHOR_IDENT"], { cwd: where, stdio: "ignore", shell: false });
      mark(true, "git identity", "configured");
    } catch {
      mark(
        false,
        "git identity",
        'git has no author configured, so commits will fail — `git config --global user.name "..."` ' +
          "and user.email, or run with --no-git-commit"
      );
    }
  }

  const sig = resolveSignalPath();
  rows.push(`${sig ? "  ok  " : " note "} ${"bridge".padEnd(14)} ${sig ?? "no plugin storage dir; interval polling only"}`);

  console.log(`${PLUGIN_TITLE} — logseq-sync doctor\n`);
  console.log(rows.join("\n"));
  console.log(
    blocked
      ? "\nNot ready: fix the MISS lines above."
      : "\nReady. Run `logseq-sync` with no arguments to start syncing."
  );
  process.exit(blocked ? 1 : 0);
}

if (subcommand === "doctor") doctor();

// --- resolved, from here on -----------------------------------------------
graphName = resolveGraphOrExit();

// Validate graph name to prevent command/path injection
// The first character must not be a dash or a dot: the name travels as argv
// into the exporting CLI, where a leading dash reads as a flag ("-graph"
// arrived here as a real user typo for --graph), and "." / ".." read as paths.
if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(graphName)) {
  console.error(`Error: Invalid graph name "${graphName}". Only alphanumeric characters, hyphens, and underscores are allowed.`);
  process.exit(2);
}

// `logseq graph export --graph <name>` does not fail on an unknown name — it
// CREATES that graph and exports the empty result. A typo would then sync
// emptiness over the vault and commit it. Refuse names we cannot see,
// INCLUDING when we see none at all: a bare run calls zero graphs a hard
// error, and naming one does not make graphs exist — treating the same state
// as "cannot verify, proceed" is how `--graph demo` once sailed past this
// check straight into the vault error, and reads as a contradiction. The
// escape hatches are real, not hypothetical: LOGSEQ_ROOT_DIR when the graphs
// live elsewhere, and the API-server route, which exports whatever graph the
// app has open and ignores local directories entirely.
if (!apiServerToken && !knownGraphs.includes(graphName)) {
  console.error(
    knownGraphs.length > 0
      ? `Error: no graph named "${graphName}" — found ${knownGraphs.join(", ")}. ` +
          `(The app CLI would silently create "${graphName}" rather than fail.) ` +
          `Run \`logseq-sync doctor\` for the full picture.`
      : `Error: no graph named "${graphName}" — no graphs found under ` +
          `${join(logseqRootDir(probe), "graphs")} at all, and the app CLI would silently ` +
          `create "${graphName}" and sync emptiness. If your graphs live elsewhere, set ` +
          `LOGSEQ_ROOT_DIR. Run \`logseq-sync doctor\` for the full picture.`
  );
  process.exit(2);
}

const targetDir = resolveVaultOrExit();
const cliCwd = process.env.LOGSEQ_CLI_DIR ?? process.cwd();
const signalPath = resolveSignalPath();
const watchMode = !flags.once;
const gitCommit = subcommand === "restore" ? false : resolveGitCommit();

if (flags.twoWay && !appCli) {
  console.error(
    "Error: --two-way needs the Logseq desktop app's CLI (it performs the imports). " +
      "Install Logseq, or pass --app-cli <path>. Run `logseq-sync doctor` for the full picture."
  );
  process.exit(2);
}

function isGitRepo(dir) {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: dir, stdio: "ignore", shell: false,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether this run commits. A vault can be somebody's Dropbox or iCloud folder;
 * turning it into a git repository is not a decision to make on their behalf.
 * So: commit into a repository that already exists, create one only when asked.
 */
function resolveGitCommit() {
  if (flags.gitCommit === false) return false;
  mkdirSync(targetDir, { recursive: true });
  if (isGitRepo(targetDir)) return true;
  if (flags.gitCommit === true) {
    try {
      execFileSync("git", ["init", "-q"], { cwd: targetDir, stdio: "ignore", shell: false });
      console.log(`Initialised a git repository in ${targetDir}`);
      return true;
    } catch (err) {
      console.error(`Could not initialise a git repository in ${targetDir}: ${redact(err.message)}`);
      return false;
    }
  }
  return false;
}

// The status file lands beside the signal file — the plugin's storage
// directory — the one place logseq.FileStorage.getItem can read it back from.
function writeStatus(status) {
  if (!signalPath) return;
  try {
    mkdirSync(dirname(signalPath), { recursive: true });
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

  // On Windows the npx fallback is an instruction, not a spawn: Node refuses
  // to run a .cmd without a shell (CVE-2024-27980), and routing a user-typed
  // graph name through cmd.exe to get around that is how injection happens.
  // Every prior attempt died as `spawnSync npx.cmd EINVAL`, once every poll.
  if (process.platform === "win32") {
    throw new Error(
      "@logseq/cli is not installed where I can see it. Install it once\n" +
      "  (mkdir logseq-cli && cd logseq-cli && npm init -y && npm i @logseq/cli)\n" +
      "and point LOGSEQ_CLI_DIR at that directory — or pass --app-cli <path>\n" +
      "to the desktop app's CLI."
    );
  }
  return execFileSync("npx", ["-y", "@logseq/cli", ...cmdArgs], {
    cwd: cliCwd,
    encoding: "utf8",
    shell: false,
    maxBuffer: 1 << 28,
  });
}

// 2.0 renamed the human-readable graph export: :graph now means the datoms
// dump, and :graph-human is the {:pages-and-blocks ...} shape this converter
// reads. Verified against the 2.0.1 app bundle.
function appCliRun(...cmdArgs) {
  return execFileSync(
    appCli.command,
    [...appCli.argsPrefix, ...cmdArgs],
    { encoding: "utf8", shell: false, maxBuffer: 1 << 28, env: { ...process.env, ...appCli.env } }
  );
}

function runAppCli(outFile) {
  return appCliRun(
    "graph", "export", "--graph", graphName, "--type", "edn", "--file", outFile,
    "-e", "{:export-type :graph-human}"
  );
}

/** How many pages a directory holds — the only sanity check worth running before an import. */
function countVaultPages(dir) {
  let n = 0;
  for (const sub of ["pages", "journals"]) {
    try {
      n += readdirSync(join(dir, sub)).filter((f) => f.endsWith(".geml")).length;
    } catch {}
  }
  return n;
}

/**
 * Vault ➔ graph. The one direction that writes into somebody's notes, so it
 * rehearses by default and takes the app's own backup before it commits to
 * anything.
 */
async function restore() {
  const pages = countVaultPages(targetDir);
  if (pages === 0) {
    console.error(
      `Error: no pages found in ${targetDir} — expected .geml files under pages/ or journals/. Not a vault this can restore from.`
    );
    process.exit(2);
  }
  if (!appCli) {
    console.error(
      "Error: restore needs the Logseq desktop app's CLI (it performs the import). Install Logseq, or pass --app-cli <path>."
    );
    process.exit(2);
  }

  console.log(`Restore: ${targetDir} (${pages} pages) ➔ graph "${graphName}"`);

  if (!flags.yes) {
    console.log(
      `\nThis is a rehearsal — nothing has been written.\n` +
        `Re-run with --yes to import, which will:\n` +
        (flags.backup ? `  1. take a Logseq backup of "${graphName}"\n  2. ` : "  1. ") +
        `import ${pages} pages into "${graphName}", merging by block uuid.`
    );
    return;
  }

  if (flags.backup) {
    try {
      appCliRun("graph", "backup", "create", "--graph", graphName);
      console.log(`  Backed up "${graphName}" first.`);
    } catch (err) {
      console.error(`Error: backup failed, so the import was NOT attempted: ${redact(err.message)}`);
      process.exit(1);
    }
  }

  const tmpEdn = join(tmpdir(), `geml-restore-${process.pid}-${randomUUID()}.edn`);
  try {
    atomicWriteFileSync(tmpEdn, syncDiskToEdn(targetDir, { parse: parseGeml, addressedUnits, sliceUnit }));
    appCliRun("graph", "import", "--graph", graphName, "--type", "edn", "--input", tmpEdn);
    console.log(`  Imported ${pages} pages into "${graphName}".`);
  } catch (err) {
    console.error(`Restore failed: ${redact(err.message)}`);
    process.exit(1);
  } finally {
    if (existsSync(tmpEdn)) { try { unlinkSync(tmpEdn); } catch {} }
  }
}

let lastEdnHash = null;

// ⑤'s bookkeeping: a graph backup before the session's first import, then
// every BACKUP_EVERY imports after — enough that an import gone wrong always
// has a recent restore point, without one backup per keystroke.
let sessionBackupTaken = false;
let importsSinceBackup = 0;
const BACKUP_EVERY = 10;

// Export the graph as EDN into tempPath — the one exporter, used once per
// cycle, twice when a two-way import changed the graph mid-cycle.
// With a token the CLI goes through the running app's HTTP API server and
// exports whatever graph the app has OPEN — the graph name is not part of
// that request, so -a REPLACES -g rather than joining it. Without a token
// the CLI opens the named graph's sqlite directly, which only works while
// the app does not hold the lock on it.
function exportGraphEdn(tempPath) {
  if (appCli) {
    runAppCli(tempPath);
  } else {
    const exportSource = apiServerToken ? ["-a", apiServerToken] : ["-g", graphName];
    runLogseqCli("export-edn", ...exportSource, "-f", tempPath);
  }
}

// The import half of --two-way, run before the export lands on disk: whatever
// a person or agent changed in the vault goes back into the graph first, so
// the write that follows holds the merged state and re-baselines the
// manifest. Deletions are reported, never imported (the vault's stance, now
// in both directions); a file changed on BOTH sides since the last sync is a
// conflict — importing it would clobber the graph's edit, exporting over it
// would clobber the person's, so two-way does neither and says so until a
// person merges.
async function importExternalEdits(ednText) {
  const graphFiles = ednToGemlFiles(ednText);
  const edits = detectExternalEdits(targetDir, { graphFiles });
  if (!edits.baselineKnown) {
    // A v1 manifest (or none) has no content baseline — the sync about to run
    // writes one, and the NEXT cycle can start importing.
    return { imported: 0, conflicts: [], missing: [] };
  }
  const importable = [...edits.modified, ...edits.added];
  const result = { imported: 0, conflicts: edits.conflicts, missing: edits.missing };
  if (edits.missing.length > 0) {
    console.log(
      `  two-way: ${edits.missing.length} vault file(s) deleted on disk — deletions are never imported; ` +
        `delete the page in Logseq if you mean it.`
    );
  }
  if (importable.length === 0) return result;

  if (!sessionBackupTaken || importsSinceBackup >= BACKUP_EVERY) {
    appCliRun("graph", "backup", "create", "--graph", graphName);
    sessionBackupTaken = true;
    importsSinceBackup = 0;
  }

  const tmpEdn = join(tmpdir(), `geml-twoway-${process.pid}-${randomUUID()}.edn`);
  try {
    atomicWriteFileSync(
      tmpEdn,
      syncDiskToEdn(targetDir, { parse: parseGeml, addressedUnits, sliceUnit }, { exclude: edits.conflicts })
    );
    appCliRun("graph", "import", "--graph", graphName, "--type", "edn", "--input", tmpEdn);
  } finally {
    if (existsSync(tmpEdn)) { try { unlinkSync(tmpEdn); } catch {} }
  }
  importsSinceBackup += 1;
  result.imported = importable.length;
  console.log(
    `[${new Date().toLocaleTimeString()}] two-way: imported ${importable.length} vault edit(s) into "${graphName}"` +
      (edits.conflicts.length ? `; ${edits.conflicts.length} conflict(s) held` : "") +
      `.`
  );
  return result;
}

async function performSync() {
  const tempEdnPath = join(tmpdir(), `logseq-export-${process.pid}-${Date.now()}-${randomUUID()}.edn`);
  try {
    // 1. Export from Logseq DB via official CLI.
    exportGraphEdn(tempEdnPath);

    if (!existsSync(tempEdnPath)) {
      throw new Error(`Export failed: ${tempEdnPath} was not created.`);
    }

    const stat = statSync(tempEdnPath);
    if (stat.size === 0) {
      throw new Error(`Export produced an empty (0 byte) EDN file.`);
    }

    let ednText = readFileSync(tempEdnPath, "utf8");

    // 1.5 Two-way import, BEFORE the unchanged-export short-circuit below:
    // the graph being unchanged says nothing about the vault.
    let twoWay = null;
    if (flags.twoWay) {
      twoWay = await importExternalEdits(ednText);
      if (twoWay.imported > 0) {
        // The graph just absorbed the vault edits — export again, so the disk
        // write and the manifest baseline hold the merged state.
        exportGraphEdn(tempEdnPath);
        ednText = readFileSync(tempEdnPath, "utf8");
      }
    }
    const twoWayActivity =
      twoWay !== null && (twoWay.imported > 0 || twoWay.conflicts.length > 0 || twoWay.missing.length > 0);

    // 2. Efficiency: In watch mode, skip disk scanning if export content is bit-for-bit identical
    const currentHash = createHash("sha256").update(ednText).digest("hex");
    if (watchMode && currentHash === lastEdnHash && !twoWayActivity) {
      return;
    }

    // 3. Incremental sync to disk
    const res = await syncEdnToDisk(ednText, targetDir, {
      autoCommit: gitCommit,
      deleteOrphans: flags.mirror,
      overwriteUnmanaged: flags.overwriteUnmanaged,
      preserve: twoWay?.conflicts ?? [],
      markdownDir: flags.markdown ? resolve(expandHome(flags.markdown)) : null,
      lib: gemlLib,
      commitMessage: flags.message || `logseq-geml: sync graph "${graphName}" (${new Date().toISOString()})`,
    });

    // Files that were on disk before this sync ever ran. Named, never counted
    // as written: silence here is how a person's own graph gets eaten.
    const heldBack = [...(res.unmanaged ?? []), ...(res.markdownUnmanaged ?? [])];

    lastEdnHash = currentHash;
    writeStatus({
      ok: true,
      at: new Date().toISOString(),
      graph: graphName,
      written: res.written.length,
      unchanged: res.unchanged.length,
      orphaned: res.orphaned.length,
      deleted: res.deleted.length,
      imported: twoWay?.imported ?? 0,
      conflicts: twoWay?.conflicts ?? [],
      held: heldBack,
    });

    const timestamp = new Date().toLocaleTimeString();
    const parts = [`${res.written.length} written`, `${res.unchanged.length} unchanged`];
    if (heldBack.length > 0) {
      parts.push(`${heldBack.length} held (not ours to overwrite)`);
    }
    if (twoWay && twoWay.imported > 0) {
      parts.unshift(`${twoWay.imported} imported`);
    }
    if (res.orphaned && res.orphaned.length > 0) {
      parts.push(`${res.orphaned.length} orphaned/absent from export (preserved safely)`);
    }
    if (res.deleted && res.deleted.length > 0) {
      parts.push(`${res.deleted.length} deleted`);
    }
    if (twoWay && twoWay.conflicts.length > 0) {
      console.error(
        `  ⚠ conflict(s), changed in BOTH the vault and the graph since the last sync — ` +
          `held as you left them, not imported, not overwritten: ${twoWay.conflicts.join(", ")}`
      );
    }
    if (heldBack.length > 0) {
      console.error(
        `  ⚠ ${heldBack.length} file(s) were already here before this sync owned them and differ from the graph — ` +
          `left exactly as you wrote them: ${heldBack.join(", ")}. ` +
          `Pass --overwrite-unmanaged to replace them with the graph's version.`
      );
    }

    if (res.written.length > 0 || res.deleted.length > 0 || heldBack.length > 0 || twoWayActivity) {
      console.log(`[${timestamp}] Synced: ${parts.join(", ")}.`);
      if (res.gitResult && res.gitResult.committed) {
        console.log(`  Git: ${res.gitResult.output}`);
      } else if (res.gitResult && res.gitResult.changes) {
        // The files are on disk, but the commit this run promised did not
        // happen. Saying only "Synced" here would be a lie of omission.
        console.error(`  Git: NOT COMMITTED — ${redact(res.gitResult.output)}`);
      }
    } else if (!watchMode) {
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
  if (subcommand === "restore") return await restore();

  // Print the resolved plan, not the flags that produced it — most of these
  // were detected, and a wrong detection has to be visible at a glance.
  // Never echo the token itself; these logs get pasted into bug reports.
  console.log(`${PLUGIN_TITLE}: graph "${graphName}" ➔ ${targetDir}`);
  if (appCli) {
    console.log(`  export via  ${appCli.command} (${appCli.how}) — works with the graph open`);
  } else if (apiServerToken) {
    console.log("  export via  @logseq/cli through the app's API server");
  } else {
    console.log("  export via  @logseq/cli, opening the graph file directly — close the graph in Logseq first");
  }
  if (signalPath) console.log(`  bridge      ${signalPath}`);
  if (gitCommit) {
    console.log("  git         auto-commit on, scoped to the vault");
  } else if (flags.gitCommit !== false) {
    console.log(`  git         off — ${targetDir} is not a repository (\`git init\` there, or pass --git-commit)`);
  }
  if (flags.markdown) {
    console.log(`  markdown    also writing a lossy Markdown copy to ${resolve(flags.markdown)}`);
  }
  if (flags.mirror) {
    console.log("  mirror      pages removed from the graph WILL be deleted here");
  }

  if (!watchMode) {
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
