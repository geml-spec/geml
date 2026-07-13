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
// `zip` where available (macOS/Linux); on Windows fall back to the SYSTEM
// bsdtar (System32\tar.exe, Windows 10+), which writes zip archives via `-a`
// from the extension. Addressed explicitly — a GNU tar earlier on PATH
// (GnuWin32, MSYS) can't write zip and would poison a bare `tar` fallback.
// Both tools preserve the relative paths (src/bg.js stays under src/).
const tryRun = (cmd, args) => {
  try {
    execFileSync(cmd, args, { cwd: root, stdio: "inherit" });
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return false; // tool not there — try the next one
    throw e;
  }
};
const bsdtar = process.platform === "win32"
  ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\tar.exe`
  : "tar";
const files = ["manifest.json", "dist", "src/bg.js", "icons"];
if (!tryRun("zip", ["-r", "-X", out, ...files]) && !tryRun(bsdtar, ["-a", "-c", "-f", out, ...files])) {
  console.error("neither `zip` nor a zip-capable `tar` found — install one and retry");
  process.exit(1);
}
console.log(`\npackaged ${out}`);
