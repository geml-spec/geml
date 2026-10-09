// Run every suite in its own node process, one after another; exit non-zero
// when any fails, naming it.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const suites = readdirSync(here).filter((f) => f.endsWith(".test.mjs")).sort();
const failed = [];
for (const s of suites) {
  const r = spawnSync(process.execPath, [join(here, s)], { stdio: "inherit" });
  if (r.status !== 0) failed.push(s);
}
console.log(failed.length ? `\n${failed.length} of ${suites.length} suites failed: ${failed.join(", ")}` : `\nall ${suites.length} suites passed`);
process.exit(failed.length ? 1 : 0);
