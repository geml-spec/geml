// Run every integration's own test suite.
//
//   node integrations/test-all.mjs
//
// This lives at the integrations layer on purpose. `geml-parser/test/all.mjs`
// is the PARSER's suite, and it briefly grew a list of which integration needs
// which npm package and how to install it — knowledge the parser has no reason
// to hold, and a list that would gain an entry for every integration added.
// The parser does not care whether a plugin is installable; this runner does.
//
// What it does NOT do is install anything. See the note at the top of
// geml-parser/test/all.mjs: npm prepends node_modules/.bin to PATH at every
// nesting level, and three layers under a long worktree path overflowed
// cmd.exe's 8191-character limit, after which the suite could not find tsc.
// One npm layer per integration — the same single layer CI uses — is safe;
// installing from inside the runner is how that grows a third.
//
// An integration with a package.json but no `test` script is REPORTED, not
// skipped: "has code, has no tests" is the kind of thing a summary should say
// out loud rather than hide behind a clean exit.

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

// Several integrations import the built parser (geml-viewer bundles it,
// logseq's tests read geml-parser/dist/geml.js). Saying so once, up front, beats
// three suites failing with ERR_MODULE_NOT_FOUND on a path nobody recognises.
const dist = join(repo, "geml-parser", "dist", "geml.js");
if (!existsSync(dist)) {
  console.error("geml-parser is not built — integrations that bundle or import it cannot run.");
  console.error("  npm --prefix geml-parser install && npm --prefix geml-parser run build");
  process.exit(2);
}

// npm on Windows is a .cmd shim, and since Node 18.20/20.12 spawning a .cmd
// WITHOUT a shell is refused outright (EINVAL) — a deliberate guard against
// argument-injection through cmd.exe. So Windows needs shell: true and POSIX
// does not. That is safe here only because every argument below is a literal:
// the one variable, the working directory, travels as the `cwd` option and
// never touches the command line. Do not interpolate anything into these args.
const WIN = process.platform === "win32";
const NPM = WIN ? "npm.cmd" : "npm";

function readManifest(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return null;   // no package.json, or unreadable — not a JS integration
  }
}

// Present when the manifest declares dependencies but none are installed. A
// missing install is a SKIP with a command to fix it, never a failure: a fresh
// clone has no node_modules anywhere, and that is not a broken integration.
function depsMissing(dir, manifest) {
  const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  if (declared.length === 0) return false;
  return !existsSync(join(dir, "node_modules"));
}

// Installed versions that do not match the lockfile. Read off disk rather than
// asked of npm: this runner deliberately spawns no npm layer of its own (see the
// note at the top), and one `npm ls` per integration would be exactly the layer
// it avoids.
//
// Reported, not failed, and for the same reason "has code, has no tests" is
// reported: a stale tree is not a broken integration, it is a fact about this
// machine that the suite result alone hides. On 2026-09-17 a geml-viewer suite
// failed here on `style.aspectRatio` and read for two rounds as an upstream bug;
// the cause was linkedom 0.18.12 installed against a lock pinning 0.18.13, and
// `npm ci` fixed it. CI always runs `npm ci`, so CI never sees any of this —
// which is precisely why the local runner has to say it out loud.
function depsStale(dir, manifest) {
  let lock;
  try { lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8")); }
  catch { return []; }
  const out = [];
  for (const dep of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
    const pinned = lock.packages?.[`node_modules/${dep}`]?.version;
    if (pinned === undefined) continue;
    let installed;
    try { installed = JSON.parse(readFileSync(join(dir, "node_modules", dep, "package.json"), "utf8")).version; }
    catch { continue; } // absent is `depsMissing`'s story, not this one
    if (installed !== pinned) out.push(`${dep} ${installed} != ${pinned}`);
  }
  return out;
}

function runIntegration(name, dir) {
  return new Promise((resolve) => {
    const chunks = [];
    const began = Date.now();
    // Buffered and printed whole: interleaved output from parallel suites is
    // unreadable, and knowing WHICH integration failed matters more than
    // watching it happen. Same reasoning as the parser's runner.
    const p = spawn(NPM, ["test", "--silent"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"], shell: WIN });
    p.stdout.on("data", (d) => chunks.push(d));
    p.stderr.on("data", (d) => chunks.push(d));
    p.on("error", (err) => {
      chunks.push(Buffer.from(`could not start ${NPM}: ${err.message}\n`));
      resolve({ name, code: 1, ms: Date.now() - began, out: Buffer.concat(chunks).toString() });
    });
    p.on("close", (code) => {
      resolve({ name, code: code ?? 1, ms: Date.now() - began, out: Buffer.concat(chunks).toString() });
    });
  });
}

const dirs = readdirSync(here, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
  .map((e) => e.name)
  .sort();

const jobs = [];
const untested = [];
const skipped = [];
const stale = [];

for (const name of dirs) {
  const dir = join(here, name);
  const manifest = readManifest(dir);
  if (!manifest) continue;                       // not a JS project (manifests, grammars, icons)
  if (!manifest.scripts?.test) { untested.push(name); continue; }
  if (depsMissing(dir, manifest)) {
    skipped.push({ name, hint: `npm --prefix integrations/${name} install` });
    continue;
  }
  const drift = depsStale(dir, manifest);
  if (drift.length > 0) stale.push({ name, drift });
  jobs.push({ name, dir });
}

for (const s of skipped) console.log(`skip ${s.name} — dependencies not installed (${s.hint})`);
// Printed BEFORE the suites run, so a failure below can be read against it
// rather than diagnosed for two rounds and then traced back to this.
for (const s of stale) {
  console.log(`stale ${s.name} — node_modules does not match package-lock.json; ` +
    `a failure below may be this, not the code (npm --prefix integrations/${s.name} ci)`);
  for (const d of s.drift) console.log(`        ${d}`);
}

// Sequential. There are a handful of integrations, several of them build
// bundles, and two esbuild runs competing for the same machine buys nothing
// worth the interleaved failure output.
const began = Date.now();
const results = [];
for (const job of jobs) {
  console.log(`\n── ${job.name}`);
  const r = await runIntegration(job.name, job.dir);
  process.stdout.write(r.out);
  results.push(r);
}
const wall = ((Date.now() - began) / 1000).toFixed(1);

console.log("");
if (untested.length) {
  console.log(`no test script: ${untested.join(", ")} — code without a suite, which is worth knowing`);
}
const failed = results.filter((r) => r.code !== 0);
if (failed.length) {
  console.log(`\n${failed.length} of ${results.length} integrations FAILED: ${failed.map((r) => r.name).join(", ")}`);
  process.exit(1);
}
console.log(`${results.length} integration${results.length === 1 ? "" : "s"} passed in ${wall}s` +
  (skipped.length ? ` (${skipped.length} skipped)` : ""));
