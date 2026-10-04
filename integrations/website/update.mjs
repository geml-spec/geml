#!/usr/bin/env node
// Write the files geml-spec.github.io serves that are made from this repository,
// into a checkout of it, then check every demo document there with this parser.
// The website workflow (.github/workflows/website.yml) runs it and commits the
// result to the site; run it by hand the same way.
//
//   node integrations/website/update.mjs [<site-checkout>]   (default: ../geml-spec.github.io)
//
// Needs geml-parser built (npm run build) and integrations/chrome-geml-viewer installed (npm ci).
//
//   public/playground/playground.js, fonts/   the playground bundle (geml-viewer's playground.build.mjs)
//   public/playground/codemap/                the parser's and the viewer's own call graph
//   public/logo/                              docs/assets/logo/, the five files the site uses
//   public/favicon.ico                        docs/assets/logo/geml.ico, for the browsers and crawlers that ask for it
import { existsSync, mkdirSync, rmSync, copyFileSync, readdirSync, mkdtempSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const site = resolve(process.argv[2] ?? join(repo, "..", "geml-spec.github.io"));
const geml = join(repo, "geml-parser", "dist", "geml.js");
const viewer = join(repo, "integrations", "chrome-geml-viewer");
const playground = join(site, "public", "playground");
// An exact version: npx fetches it at run time, and what it writes is published
// on the site, so a new release must not reach the site unread. Raise it by hand.
const SCIP_TS = "@sourcegraph/scip-typescript@0.4.0";

for (const [what, p] of [
  ["a site checkout", join(site, "public", "playground", "index.html")],
  ["the parser build (cd geml-parser && npm run build)", geml],
  ["the viewer's node_modules (cd integrations/chrome-geml-viewer && npm ci)", join(viewer, "node_modules", "esbuild")],
]) {
  if (!existsSync(p)) { console.error(`website: ${what} is missing at ${p}`); process.exit(1); }
}

// npx is a .cmd shim on Windows, so it needs a shell there; node itself must not
// go through one (its path has spaces).
function run(argv, cwd = repo) {
  const r = spawnSync(argv[0], argv.slice(1), { cwd, stdio: "inherit", shell: process.platform === "win32" && argv[0] === "npx" });
  if (r.status !== 0) { console.error(`website: ${argv.join(" ")} exited ${r.status}`); process.exit(r.status ?? 1); }
}

// 1. The playground bundle and KaTeX's fonts.
run([process.execPath, join(viewer, "playground.build.mjs"), playground], viewer);

// 2. The code graph the playground's chapter 5 draws: index both packages,
//    merge them into one graph, verify it, render every document to HTML.
const codemap = join(playground, "codemap");
const build = mkdtempSync(join(tmpdir(), "geml-site-codemap-"));
rmSync(codemap, { recursive: true, force: true });
run(["npx", "--yes", SCIP_TS, "index", "--output", join(build, "parser.scip")], join(repo, "geml-parser"));
run(["npx", "--yes", SCIP_TS, "index", "--output", join(build, "viewer.scip")], viewer);
run([process.execPath, geml, "codemap", "build",
  "--adapter", "scip", "--raw", join(build, "parser.scip"),
  "--adapter", "scip", "--raw", join(build, "viewer.scip"),
  "--root", repo, "--out", codemap, "--container", "file", "--build", join(build, "_build")]);
run([process.execPath, geml, "codemap", "verify", codemap]);
run([process.execPath, geml, "codemap", "render", codemap]);
rmSync(build, { recursive: true, force: true });

// 3. The logos.
const logoOut = join(site, "public", "logo");
mkdirSync(logoOut, { recursive: true });
for (const f of ["geml-favicon.svg", "geml-mark.svg", "geml-mark-mono.svg", "geml-logo-light.svg", "geml-logo-dark.svg"]) {
  copyFileSync(join(repo, "docs", "assets", "logo", f), join(logoOut, f));
}
// A page that names no icon makes the browser ask for /favicon.ico; so do crawlers.
copyFileSync(join(repo, "docs", "assets", "logo", "geml.ico"), join(site, "public", "favicon.ico"));

// 4. Every demo document the site ships must pass this parser's check. The
//    codemap is checked by its own verify above.
const docs = [];
(function walk(dir) {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) { if (!["codemap", "node_modules", "fonts", "_build"].includes(d.name)) walk(p); }
    else if (d.name.endsWith(".geml")) docs.push(p);
  }
})(join(site, "public"));
let failed = 0;
for (const f of docs) {
  const r = spawnSync(process.execPath, [geml, "check", f, "--root", join(site, "public")], { encoding: "utf8" });
  if (r.status !== 0) { failed++; process.stdout.write(`✗ ${relative(site, f)}\n${r.stdout}${r.stderr}`); }
}
console.log(`website: ${docs.length - failed} of ${docs.length} demo documents check clean`);
if (failed) process.exit(1);
console.log(`website: ${relative(process.cwd(), site) || "."} is up to date with this checkout`);
