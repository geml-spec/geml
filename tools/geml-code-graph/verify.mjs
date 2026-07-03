#!/usr/bin/env node
// geml-code-graph verify — run `geml check` over every .geml under a directory.
// The build's correctness oracle (DESIGN-geml-code-graph §6/§9): cross-document
// references (forward docs <-> backlinks <-> index) must all resolve; a stale
// or missed regeneration surfaces here as a hard failure.
//
//   node tools/geml-code-graph/verify.mjs <dir> [--geml <path-to-geml.js|geml>]
import { readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("-"));
const flagI = args.indexOf("--geml");
if (!dir) {
  console.error("usage: node tools/geml-code-graph/verify.mjs <dir> [--geml <path>]");
  process.exit(2);
}

// Resolve the geml CLI: --geml, then this repo's built parser, then PATH.
let cli = flagI >= 0 ? args[flagI + 1] : undefined;
if (!cli) {
  const local = resolve(dirname(fileURLToPath(import.meta.url)), "../../geml-parser/dist/geml.js");
  cli = existsSync(local) ? local : "geml";
}
const run = (file) => cli.endsWith(".js")
  ? spawnSync(process.execPath, [cli, "check", file], { encoding: "utf8" })
  : spawnSync(cli, ["check", file], { encoding: "utf8", shell: process.platform === "win32" });

const files = [];
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".geml")) files.push(p);
  }
};
walk(resolve(dir));
files.sort();

let failed = 0;
for (const f of files) {
  const r = run(f);
  if (r.status !== 0) {
    failed++;
    console.error(`FAIL ${f}`);
    console.error((r.stderr || r.stdout || "").split("\n").slice(0, 4).map((l) => `  ${l}`).join("\n"));
  }
}
console.error(`verify: ${files.length - failed}/${files.length} documents pass geml check`);
process.exit(failed ? 1 : 0);
