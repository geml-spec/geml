// Build the GEML Viewer content-script bundles.
//
// Two outputs: the core content script (parser + renderer + KaTeX) and a
// separate mermaid chunk. Mermaid dominated the old single bundle, so it is
// split out and injected by the background worker (src/bg.js) only when a page
// actually contains a diagram — every other page skips its parse/execute cost.
// The parser's Node-only CLI/history paths are neutralized here (they never
// run in a page):
//   - alias node:fs/path/crypto → a harmless stub so static imports resolve
//   - define process.argv → [] so the CLI entry guard evaluates to false
//   - define import.meta.url → "" so the CLI's codemap-dispatch path (dead in a
//     page) doesn't trip the "import.meta unavailable in iife" warning
import * as esbuild from "esbuild";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const stub = resolve(root, "src/node-stub.js");
const parserDir = resolve(root, "../geml-parser");
const parserDist = resolve(parserDir, "dist/geml.js");

// We bundle geml-parser's compiled output; it must be built first.
if (!existsSync(parserDist)) {
  console.error(
    "geml-parser is not built. Run this once, then retry:\n" +
      "  cd ../geml-parser && npm install && npm run build",
  );
  process.exit(1);
}

mkdirSync(resolve(root, "dist"), { recursive: true });

const common = {
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome110",
  loader: { ".css": "text" },
  define: { "process.argv": "[]", "import.meta.url": "\"\"" },
  alias: { "node:fs": stub, "node:path": stub, "node:crypto": stub, "node:url": stub, "node:child_process": stub },
  logLevel: "info",
};

await esbuild.build({
  ...common,
  entryPoints: [resolve(root, "src/content.js")],
  outfile: resolve(root, "dist/viewer.bundle.js"),
});

// The lazy mermaid chunk (see src/mermaid-chunk.js for why it's a separate
// executeScript-injected file rather than a dynamic import).
await esbuild.build({
  ...common,
  entryPoints: [resolve(root, "src/mermaid-chunk.js")],
  outfile: resolve(root, "dist/mermaid.chunk.js"),
});

// The lazy D2 chunk: the Go→WASM engine (wasm inlined, ~8MB), loaded only by
// the sandboxed page (d2-sandbox.html) inside the offscreen document — never
// by a content script (see src/d2-sandbox.js for the CSP story).
await esbuild.build({
  ...common,
  entryPoints: [resolve(root, "src/d2-sandbox.js")],
  outfile: resolve(root, "dist/d2.chunk.js"),
});

// The lazy Graphviz chunk: @viz-js/viz (Emscripten→WASM, wasm inlined), loaded
// only by the sandboxed page (graphviz-sandbox.html) inside the offscreen
// document — never by a content script (see src/graphviz-sandbox.js).
await esbuild.build({
  ...common,
  entryPoints: [resolve(root, "src/graphviz-sandbox.js")],
  outfile: resolve(root, "dist/graphviz.chunk.js"),
});

// KaTeX needs its font files; expose them via web_accessible_resources so the
// injected @font-face rules (rewritten to chrome-extension:// at runtime) load.
const katexFonts = resolve(root, "node_modules/katex/dist/fonts");
if (existsSync(katexFonts)) {
  cpSync(katexFonts, resolve(root, "dist/fonts"), { recursive: true });
  console.log("copied KaTeX fonts → dist/fonts");
} else {
  console.warn("KaTeX fonts not found (run npm install) — math will fall back to system fonts");
}

console.log("built dist/viewer.bundle.js");
