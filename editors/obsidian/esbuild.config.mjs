// Bundle the Obsidian plugin: main.ts + the reference parser + the viewer's
// renderer into a single CommonJS main.js. "obsidian"/"electron" are provided by
// the host and stay external. The parser's Node-only paths are neutralized the
// same way the viewer build does it (alias node:* → node-stub, define
// process.argv → []), since they never run inside Obsidian.
import * as esbuild from "esbuild";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const stub = resolve(root, "../../geml-viewer/src/node-stub.js");
const parserDist = resolve(root, "../../geml-parser/dist/geml.js");

if (!existsSync(parserDist)) {
  console.error("geml-parser is not built. Run: (cd ../../geml-parser && npm install && npm run build)");
  process.exit(1);
}

await esbuild.build({
  entryPoints: [resolve(root, "main.ts")],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2020",
  outfile: resolve(root, "main.js"),
  external: ["obsidian", "electron"],
  loader: { ".css": "text" },
  define: { "process.argv": "[]" },
  alias: { "node:fs": stub, "node:path": stub, "node:crypto": stub },
  logLevel: "info",
});

console.log("built editors/obsidian/main.js");
