// Build the GEML Viewer content-script bundle.
//
// We bundle geml-parser's compiled core together with the renderer, KaTeX and
// Mermaid into a single IIFE that the content script injects. The parser's
// Node-only CLI/history paths are neutralized here (they never run in a page):
//   - alias node:fs/path/crypto → a harmless stub so static imports resolve
//   - define process.argv → [] so the CLI entry guard evaluates to false
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

await esbuild.build({
  entryPoints: [resolve(root, "src/content.js")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome110",
  outfile: resolve(root, "dist/viewer.bundle.js"),
  loader: { ".css": "text" },
  define: { "process.argv": "[]" },
  alias: { "node:fs": stub, "node:path": stub, "node:crypto": stub },
  logLevel: "info",
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
