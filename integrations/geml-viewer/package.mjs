// Package the extension into a Chrome Web Store upload: manifest.json at the
// zip root, plus exactly what the manifest references — dist/ (bundles +
// KaTeX fonts), the unbundled service worker (src/bg.js), and icons/. The
// parked D2/Graphviz sandbox pages and offscreen relay (see build.mjs) are
// deliberately left out until they ship.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
const out = resolve(root, `geml-viewer-${manifest.version}.zip`);

for (const f of ["dist/viewer.bundle.js", "dist/mermaid.chunk.js", "dist/fonts"]) {
  if (!existsSync(resolve(root, f))) {
    console.error(`${f} missing — run \`npm run build\` first`);
    process.exit(1);
  }
}

rmSync(out, { force: true });
execFileSync("zip", ["-r", "-X", out, "manifest.json", "dist", "src/bg.js", "icons"], {
  cwd: root,
  stdio: "inherit",
});
console.log(`\npackaged ${out}`);
