// Run the extension's test files, in order, and fail on the first that fails.
//
// The suites test the parts that are the extension's OWN logic — the reference
// lexer, the block-at-a-line rule, the id whitelist — and the CLI contract every
// feature is built on. Providers, webviews and commands need a real extension
// host and are not covered here; media/smoke.html is how the webview half gets
// looked at.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

if (!existsSync(resolve(here, "../out/refs.js"))) {
  console.error("out/ is missing — run `npm run compile` first (the tests run against what ships).");
  process.exit(2);
}

const suites = ["refs.test.cjs", "cli.test.cjs"];

for (const suite of suites) {
  console.log(`\n--- ${suite} ---`);
  const r = spawnSync(process.execPath, [resolve(here, suite)], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`\n${suite} failed.`);
    process.exit(r.status ?? 1);
  }
}

console.log("\nall vscode suites passed.");
