// Run every suite in its own node process (they spawn servers and CLIs and
// rely on process isolation), several at a time — WITHOUT an inner npm layer.
// npm-in-npm prepends node_modules/.bin to PATH at every nesting level, and
// under a long worktree path that overflows cmd.exe's 8191-character variable
// limit; the inner script shell then resolves neither tsc nor node. Measured
// on a temp-dir worktree: PATH grew 6185 → 7357 → 8256 chars across the
// bash → npm → c8+npm layers, and the suite died with "'tsc' is not
// recognized". One npm layer + this runner stays safe anywhere.
//
// The suites are independent — each builds its own temp directory — so they run
// concurrently, which is where the wall-clock goes: the work is dominated by
// node start-up, roughly 150ms per CLI invocation across some five hundred of
// them, and that cost parallelises even though the machine does not get faster.
//
// Six lanes, measured rather than assumed: 4 and 6 come out the same within
// run-to-run noise, 8 is slower, and 11 killed a suite outright. Four lanes
// already only buy a 1.7–2.0× speed-up over running them one after another,
// which says the machine is saturated long before the lane count is — each
// lane is a suite, and a suite spawns hundreds of CLI children of its own.
//
// The suites that start an HTTP server run in the pool with everything else.
// They pick a random high port per server rather than a fixed one, so there is
// no shared port to fight over.
//
// One other departure from how this used to run:
//
//   * It no longer stops at the first failure. Fail-fast made a single early
//     crash look like a catastrophe — the run would abort, the suites after it
//     never executed, and the coverage report showed their files at zero, which
//     reads as "coverage collapsed" rather than "one suite died". Every suite
//     now runs and every failure is listed at the end.
import { spawn } from "node:child_process";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const suites = [
  "preliminaries",
  "m2", "emphasis-atoms", "m3", "m4", "convert", "fixtures", "features", "render",
  "view-block",
  "conformance", "second-impl", "roundtrip", "to-md", "history",
  "render-html", "codemap", "cli", "skill-install", "get-set", "replace", "find", "projection-refusals", "view-depth", "block-edit", "add", "delete", "rename", "revert", "to", "language-projection",
  // branch-coverage suites: each targets the uncovered arms of one file
  // cluster (converters, render.js, history+CLI, codemap scripts/adapters,
  // serve, and both MCP servers) — kept separate from the feature suites they
  // extend, because what they cover is refusal logic rather than a feature.
  "cov-convert", "cov-render", "cov-history-cli", "cov-scripts", "cov-installer",
  "cov-adapters", "cov-serve", "cov-mcp",
  // GEP 0011 coordinates: the addresses that reach inside a block
  "coord",
  // the one block-selector syntax `get`/`set` share: content addresses, the
  // HEAD/BODY round-trip invariant, cardinality, and the no-silent-discard rule
  "selector",
  // block transclusion (`=== embed`) and the one src=/data= source rule
  "embed", "table-src", "source-route", "inline-project",
  // the `data` block (GEP-0005): format engines, schema= shape, chart binding
  // over record arrays, canonical serialization, previews, blind append
  "data",
  // the yaml engine for `data` bodies: the subset it reads, and the refusals
  "yaml",
  // `geml mcp` — the document-CRUD MCP server (nine tools, confined root)
  "mcp",
  // security-audit regression suites: assert the fixed secure behavior
  // (XSS/DoS/RCE/injection/path-traversal) so the holes can't silently reopen.
  "sec-parser", "sec-codemap", "sec-integrations", "sec-embed",
  // cross-stack API-link overlay (frontend call sites ⇄ backend routes)
  "cross-stack",
  // 应用层 profile 的词汇表机制（计划 C）：声明生效、限定作用域、无后门。
  "profiles",
  // geml-code-graph 的显示期调节面（计划 D）：_index/style.geml
  "graph-style",
  // geml-style profile（计划 A）：选择器引擎与样式表求解。
  // 两个 suite 分开，因为它们测的层不同 —— 一个是纯函数，一个是端到端 CLI。
  "style-selector", "style-check",
];
// Longest-first. The pool is a shared queue, so the first LIMIT names go to
// LIMIT different lanes: starting with the slow suites keeps them from stacking
// behind one another, and the tail of quick ones fills whichever lane frees up.
// Two long suites landing in the same lane costs their SUM in wall-clock, which
// is the one scheduling mistake that shows up in the total.
//
// Anything not named here keeps its position. Every run prints the slowest six
// measured, so this list can be corrected from the run that noticed.
//
// `cov-adapters` is here for VARIANCE, not for a measured average: it is the
// only suite whose duration is set by something outside this machine. Measured
// across four CI jobs it ran 6.5s, 35.7s, 133.4s and 301.5s — the last two an
// `npx` download crawling and then hitting its five-minute timeout. Starting it
// early costs nothing on the fast days and stops it stacking behind another
// long suite on the slow ones. (`codemap` reaches the network for the same
// reason and stays first: 250s on a bad day.) Anywhere in the first LIMIT names
// is the same thing operationally — each of those gets a lane immediately — so
// the order among them is a statement of intent rather than a schedule.
const SLOWEST = ["codemap", "cov-adapters", "get-set", "cov-scripts", "mcp", "cli", "selector"];
const ordered = [...suites].sort(
  (a, b) => (SLOWEST.indexOf(a) + 1 || Infinity) - (SLOWEST.indexOf(b) + 1 || Infinity),
);

// suites resolve dist/geml.js etc. relative to the package root
const cwd = join(here, "..");
// Leave a core for the parent and for whatever the suites spawn themselves.
// Overridable so the number can be measured rather than argued about:
// GEML_TEST_LANES=8 node test/all.mjs
const LIMIT = Number(process.env.GEML_TEST_LANES) || Math.max(1, Math.min(6, cpus().length - 1));

// Output is buffered and printed whole, per suite. Interleaved lines from four
// suites at once are unreadable, and the reader needs to know which suite a
// failure came from more than they need it live.
function runSuite(name) {
  return new Promise((resolve) => {
    const chunks = [];
    const began = Date.now();
    const p = spawn(process.execPath, [join(here, `${name}.test.mjs`)], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    p.stdout.on("data", (d) => chunks.push(d));
    p.stderr.on("data", (d) => chunks.push(d));
    p.on("close", (code) => {
      process.stdout.write(Buffer.concat(chunks).toString());
      resolve({ name, code: code ?? 1, ms: Date.now() - began });
    });
  });
}

async function runPool(names, limit) {
  const queue = [...names];
  const done = [];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let n = queue.shift(); n !== undefined; n = queue.shift()) done.push(await runSuite(n));
  });
  await Promise.all(workers);
  return done;
}

const began = Date.now();
const results = await runPool(ordered, LIMIT);
const wall = ((Date.now() - began) / 1000).toFixed(1);

const slowest = [...results].sort((a, b) => b.ms - a.ms).slice(0, 6);
console.log(`\nslowest: ${slowest.map((r) => `${r.name} ${(r.ms / 1000).toFixed(1)}s`).join(", ")}`);

const failed = results.filter((r) => r.code !== 0);
if (failed.length) {
  console.error(`\n${failed.length} of ${results.length} suites failed: ${failed.map((f) => f.name).join(", ")}`);
  process.exit(failed[0].code);
}
console.log(`${results.length} suites passed in ${wall}s on ${LIMIT} lanes`);
