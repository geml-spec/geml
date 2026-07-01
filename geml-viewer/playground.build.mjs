// Build the GEML playground bundle: the parser's pure core + the renderer +
// KaTeX + Mermaid, bundled into one browser IIFE that exposes `window.GEML`.
// Reuses this package's esbuild, node_modules (nodePaths), and the same
// Node-stub aliasing as the viewer build. Output lands in
// ../playground/playground.js, and KaTeX's fonts in ../playground/fonts/, so the
// playground/ folder is a self-contained static site you can drop on GitHub Pages.
import * as esbuild from "esbuild";
import { existsSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
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
  // entry.js lives in ../playground (no node_modules there); resolve bare
  // imports (katex, mermaid) from this package's node_modules.
  nodePaths: [resolve(root, "node_modules")],
  logLevel: "info",
});

// KaTeX's CSS references url(fonts/KaTeX_*.woff2); ship the woff2 files next to
// the page (./fonts/). woff2 covers every modern browser, so we skip the
// heavier woff/ttf variants katex also bundles.
const fontsSrc = resolve(root, "node_modules/katex/dist/fonts");
const fontsDst = resolve(root, "../playground/fonts");
if (existsSync(fontsSrc)) {
  mkdirSync(fontsDst, { recursive: true });
  let n = 0;
  for (const f of readdirSync(fontsSrc)) {
    if (f.endsWith(".woff2")) { copyFileSync(resolve(fontsSrc, f), resolve(fontsDst, f)); n++; }
  }
  console.log(`copied ${n} KaTeX woff2 font(s) → playground/fonts`);
} else {
  console.warn("KaTeX fonts not found (run npm install) — math will fall back to system fonts");
}

console.log("built playground/playground.js");
