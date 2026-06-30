// Build the GEML playground bundle: the parser's pure core + the pure renderer,
// bundled into one browser IIFE that exposes `window.GEML`. Reuses this
// package's esbuild and the same Node-stub aliasing as the viewer build (the
// parser's Node-only CLI/history paths never run in a page). Output lands in
// ../playground/playground.js so the playground/ folder is a self-contained
// static site you can drop on GitHub Pages.
import * as esbuild from "esbuild";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const stub = resolve(root, "src/node-stub.js");
const parserDist = resolve(root, "../geml-parser/dist/geml.js");

if (!existsSync(parserDist)) {
  console.error("geml-parser is not built. Run: cd ../geml-parser && npm install && npm run build");
  process.exit(1);
}

await esbuild.build({
  entryPoints: [resolve(root, "../playground/entry.js")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome110",
  outfile: resolve(root, "../playground/playground.js"),
  loader: { ".css": "text" },
  define: { "process.argv": "[]" },
  alias: { "node:fs": stub, "node:path": stub, "node:crypto": stub },
  logLevel: "info",
});

console.log("built playground/playground.js");
