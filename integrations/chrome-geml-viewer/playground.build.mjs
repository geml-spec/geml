// Build the GEML playground bundle: the parser's pure core + the renderer +
// KaTeX + Mermaid, bundled into one browser IIFE that exposes `window.GEML`.
// Reuses this package's esbuild, node_modules (nodePaths), and the same
// Node-stub aliasing as the viewer build. The website's playground loads it;
// integrations/website/update.mjs runs this with the site's playground folder
// as the output.
//
//   node playground.build.mjs [<out-dir>]      (default: dist-playground/)
//
// Writes <out-dir>/playground.js and KaTeX's woff2 fonts into <out-dir>/fonts/.
import * as esbuild from "esbuild";
import { existsSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const stub = resolve(root, "src/node-stub.js");
const parserDist = resolve(root, "../../geml-parser/dist");
const out = resolve(process.argv[2] ?? join(root, "dist-playground"));

if (!existsSync(join(parserDist, "geml.js"))) {
  console.error("geml-parser is not built. Run: cd ../../geml-parser && npm install && npm run build");
  process.exit(1);
}
mkdirSync(out, { recursive: true });

await esbuild.build({
  entryPoints: [resolve(root, "playground-entry.js")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome110",
  outfile: join(out, "playground.js"),
  loader: { ".css": "text" },
  define: { "process.argv": "[]", "import.meta.url": "\"\"" },
  alias: {
    // playground-entry.js imports these two by bare name.
    "geml-parser-dist": parserDist,
    "geml-viewer-src": resolve(root, "src"),
    "node:fs": stub, "node:path": stub, "node:crypto": stub, "node:url": stub, "node:child_process": stub, "node:os": stub,
  },
  // bare imports (katex, mermaid) resolve from this package's node_modules
  nodePaths: [resolve(root, "node_modules")],
  logLevel: "info",
});

const fontsSrc = resolve(root, "node_modules/katex/dist/fonts");
const fontsDst = join(out, "fonts");
mkdirSync(fontsDst, { recursive: true });
let n = 0;
for (const f of readdirSync(fontsSrc)) if (f.endsWith(".woff2")) { copyFileSync(join(fontsSrc, f), join(fontsDst, f)); n++; }
console.log(`playground: wrote ${join(out, "playground.js")} and ${n} KaTeX fonts`);
