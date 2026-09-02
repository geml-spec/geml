// Run every viewer suite in its own node process, failing fast — the same
// pattern geml-parser/test/all.mjs uses, and for the same reason: one npm layer
// only (npm-in-npm keeps prepending node_modules/.bin to PATH, which overflows
// cmd.exe's 8191-char variable limit under a long worktree path).
//
// Exists so coverage can wrap ONE command (`c8 node test/all.mjs`): c8 exports
// NODE_V8_COVERAGE, which the spawned suites inherit, so every process's
// coverage lands in one report. The suites are plain scripts (not node:test),
// so they are spawned, not imported.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// render / transclude / inline-src / chart / upgrade / security cover the
// shipped content path; d2 + graphviz cover the PARKED sandbox engines (still
// built and tested, not shipped).
const suites = ["render", "transclude", "inline-src", "chart", "upgrade", "security", "d2", "graphviz", "translate-browser", "translate-map", "snapshot"];

for (const s of suites) {
  const r = spawnSync(process.execPath, [join(here, `${s}.test.mjs`)], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`\nsuite FAILED: ${s}.test.mjs (exit ${r.status ?? r.signal})`);
    process.exit(r.status ?? 1);
  }
}
console.log("\nall viewer suites passed.");
