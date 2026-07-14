// Run every suite in its own node process (they spawn servers and CLIs and
// rely on process isolation), failing fast — WITHOUT an inner npm layer.
// npm-in-npm prepends node_modules/.bin to PATH at every nesting level, and
// under a long worktree path that overflows cmd.exe's 8191-character variable
// limit; the inner script shell then resolves neither tsc nor node. Measured
// on a temp-dir worktree: PATH grew 6185 → 7357 → 8256 chars across the
// bash → npm → c8+npm layers, and the suite died with "'tsc' is not
// recognized". One npm layer + this runner stays safe anywhere.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const suites = [
  "m2", "m3", "m4", "convert", "fixtures", "features", "render",
  "conformance", "second-impl", "roundtrip", "to-md", "history",
  "render-html", "codemap", "cli", "get-set", "revert",
];
for (const s of suites) {
  const r = spawnSync(process.execPath, [join(here, `${s}.test.mjs`)], {
    stdio: "inherit",
    cwd: join(here, ".."), // suites resolve dist/geml.js etc. relative to the package root
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
