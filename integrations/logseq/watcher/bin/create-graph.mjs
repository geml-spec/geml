// Create an empty Logseq DB graph WITHOUT the desktop app.
//
//   LOGSEQ_CLI_DIR=<dir whose node_modules holds @logseq/cli>  \
//   node bin/create-graph.mjs <graph-name>   (name travels via GEML_GRAPH_NAME —
//   nbb loadFile does not surface *command-line-args*)
//
// Why this exists: `@logseq/cli` (0.4.3) can export, import and validate a DB
// graph, but cannot create one — creation lives in the desktop app, and on a
// machine where the app cannot run (permissions, CI) that is a dead end. The
// CLI package VENDORS the whole logseq.db stack though, and its `open-db!`
// creates the sqlite tables on open; the only other thing the app does at
// create time is transact `build-db-initial-data`. So this does exactly those
// two steps, through the CLI's own vendored code — the resulting graph is one
// `logseq list/show/validate` accepts as its own (verified: schema 65.22,
// "Valid!").
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, resolve } from "path";
import { existsSync, readFileSync, copyFileSync, rmSync } from "fs";

const here = fileURLToPath(dirname(import.meta.url));
const cliDir = process.env.LOGSEQ_CLI_DIR ?? resolve(here, "..");
const CLI = resolve(cliDir, "node_modules", "@logseq", "cli");
if (!existsSync(CLI)) {
  console.error(`@logseq/cli not found under ${cliDir}/node_modules — set LOGSEQ_CLI_DIR to a directory where it is installed.`);
  console.error("Note: on Node 24 its better-sqlite3 needs an override to >=12.11.1 for a prebuilt binding.");
  process.exit(2);
}

// nbb-logseq is resolved from the CLI's install, not from this package: ESM
// import specifiers resolve relative to THIS file, which would demand a local
// install of a runtime the CLI already carries.
const nbbDir = resolve(cliDir, "node_modules", "@logseq", "nbb-logseq");
const nbbPkg = JSON.parse(readFileSync(resolve(nbbDir, "package.json"), "utf8"));
const entry = typeof nbbPkg.exports === "object"
  ? (nbbPkg.exports["."]?.import ?? nbbPkg.exports["."]) : (nbbPkg.main ?? "index.mjs");
const { loadFile, addClassPath } = await import(pathToFileURL(resolve(nbbDir, entry)).href);

global.__dirname = here;
addClassPath(resolve(CLI, "src"));
addClassPath(resolve(CLI, "vendor/src"));
// nbb resolves the stack's node `require`s (better-sqlite3) relative to the
// LOADED FILE's directory, so the .cljs must sit beside a node_modules that
// has them — copy it into the CLI dir for the duration of the run.
process.env.GEML_GRAPH_NAME = process.argv[2] ?? "geml-spike";
const staged = resolve(cliDir, ".geml-create-graph.cljs");
copyFileSync(resolve(here, "create_graph_headless.cljs"), staged);
try {
  await loadFile(staged);
} finally {
  rmSync(staged, { force: true });
}
