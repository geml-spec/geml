// Bundle the plugin for "Load unpacked plugin": dist/index.js + dist/index.html.
// dist/ is gitignored; build before loading or zipping for a release.
import { build } from "esbuild";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(here, "src", "index.js")],
  bundle: true,
  outfile: join(dist, "index.js"),
  format: "iife",
  platform: "browser",
  target: "es2020",
  logLevel: "info",
});

writeFileSync(
  join(dist, "index.html"),
  `<!doctype html>
<html>
  <head><meta charset="utf-8" /></head>
  <body><script src="./index.js"></script></body>
</html>
`
);

console.log("built dist/index.js and dist/index.html");
