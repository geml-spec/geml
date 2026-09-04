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
const stub = resolve(root, "../geml-viewer/src/node-stub.js");
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
  // Neutralize the parser's Node-only CLI paths (same as the viewer build):
  // empty argv AND an empty import.meta.url so the `entry === argv[1]` CLI-entry
  // guard is false and main() never runs at import inside Obsidian.
  define: { "process.argv": "[]", "import.meta.url": "\"\"" },
  // Alias EVERY node builtin the parser dist imports to the browser stub. Since
  // esbuild 0.25, unresolved `node:` specifiers are a hard error for
  // platform:"browser" (0.23 only warned), so node:url / node:child_process
  // must be aliased too, not just fs/path/crypto.
  alias: { "node:fs": stub, "node:path": stub, "node:crypto": stub, "node:url": stub, "node:child_process": stub },
  logLevel: "info",
});

console.log("built integrations/obsidian/main.js");
