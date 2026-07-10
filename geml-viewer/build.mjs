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

// ---------------------------------------------------------------------------
// PARKED ENGINES — D2 and Graphviz are implemented and tested but NOT shipped
// (only mermaid is popular enough for now). Everything is kept: engine code
// (src/d2-sandbox.js, src/graphviz-sandbox.js), sandbox pages, the offscreen
// relay (src/offscreen.js), bg's geml-offscreen-ensure handler, the upgrade
// functions, and their tests (test/d2.test.mjs, test/graphviz.test.mjs).
//
// Re-enable checklist:
//   1. Uncomment the two chunk builds below.
//   2. Uncomment the d2 / graphviz placeholder branches in src/render.js.
//   3. Uncomment the two upgrade blocks in src/content.js.
//   4. Restore these manifest.json entries (JSON can't hold comments):
//        "permissions": ["scripting", "offscreen"],
//        "sandbox": { "pages": ["d2-sandbox.html", "graphviz-sandbox.html"] },
//        "content_security_policy": {
//          "sandbox": "sandbox allow-scripts; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; child-src 'self' blob:; connect-src 'self' data: blob:"
//        },
//   5. Flip the two render.test.mjs fallback assertions back to placeholder ones.
//
// // The lazy D2 chunk: the Go→WASM engine (wasm inlined, ~8MB), loaded only by
// // the sandboxed page (d2-sandbox.html) inside the offscreen document — never
// // by a content script (see src/d2-sandbox.js for the CSP story).
// await esbuild.build({
//   ...common,
//   entryPoints: [resolve(root, "src/d2-sandbox.js")],
//   outfile: resolve(root, "dist/d2.chunk.js"),
// });
//
// // The lazy Graphviz chunk: @viz-js/viz (Emscripten→WASM, wasm inlined), loaded
// // only by the sandboxed page (graphviz-sandbox.html) inside the offscreen
// // document — never by a content script (see src/graphviz-sandbox.js).
// await esbuild.build({
//   ...common,
//   entryPoints: [resolve(root, "src/graphviz-sandbox.js")],
//   outfile: resolve(root, "dist/graphviz.chunk.js"),
// });
// ---------------------------------------------------------------------------

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
