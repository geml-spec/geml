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
// `zip` where available (macOS/Linux); Windows ships no zip but its bsdtar
// (tar.exe, Windows 10+) writes zip archives via `-a` from the extension —
// both preserve the relative paths (src/bg.js stays under src/).
const tryRun = (cmd, args) => {
  try {
    execFileSync(cmd, args, { cwd: root, stdio: "inherit" });
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return false; // tool not on PATH — try the next one
    throw e;
  }
};
const files = ["manifest.json", "dist", "src/bg.js", "icons"];
if (!tryRun("zip", ["-r", "-X", out, ...files]) && !tryRun("tar", ["-a", "-c", "-f", out, ...files])) {
  console.error("neither `zip` nor `tar` found on PATH — install one and retry");
  process.exit(1);
}
console.log(`\npackaged ${out}`);
