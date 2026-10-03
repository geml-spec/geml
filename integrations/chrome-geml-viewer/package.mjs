// Package the extension into a Chrome Web Store upload: manifest.json at the
// zip root, plus exactly what the manifest references — dist/ (bundles +
// KaTeX fonts), the unbundled service worker (src/bg.js), and icons/. The
// parked D2/Graphviz sandbox pages and offscreen relay (see build.mjs) are
// deliberately left out until they ship.
//
// The archive is REPRODUCIBLE: the same commit packages to the same bytes, so a
// reader can rebuild the release and compare digests instead of trusting the
// machine that uploaded it. Two things make an otherwise identical zip differ —
// the mtimes it records and the order it stores entries in — so both are
// pinned: every entry is stamped with SOURCE_DATE_EPOCH (the reproducible-builds
// convention; default 1980-01-01, the earliest a zip can represent) and the file
// list is sorted. Staging a copy keeps that out of the working tree: stamping
// the real dist/ and icons/ would confuse every incremental build after it.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
const out = resolve(root, `geml-viewer-${manifest.version}.zip`);

// A zip's DOS timestamp cannot go below 1980-01-01T00:00:00Z; a smaller
// SOURCE_DATE_EPOCH would be clamped by the tool and stop being reproducible.
const ZIP_EPOCH_FLOOR = 315532800;
const sourceDate = Math.max(
  Number.parseInt(process.env.SOURCE_DATE_EPOCH ?? "", 10) || ZIP_EPOCH_FLOOR,
  ZIP_EPOCH_FLOOR,
);

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
const bsdtar = process.platform === "win32"
  ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\tar.exe`
  : "tar";
const files = ["manifest.json", "dist", "src/bg.js", "icons", "offscreen.html", "src/offscreen.js"];

// Stage a copy, stamp it, and archive a sorted list of plain files. Directory
// entries are not stored: Chrome does not need them, and one fewer thing whose
// order and timestamp would have to be pinned.
const stage = mkdtempSync(join(tmpdir(), "geml-viewer-pkg-"));
const walk = (rel) => {
  const abs = join(stage, rel);
  if (!statSync(abs).isDirectory()) return [rel];
  return readdirSync(abs).flatMap((name) => walk(join(rel, name)));
};
try {
  for (const f of files) cpSync(resolve(root, f), join(stage, f), { recursive: true });
  const entries = files.flatMap(walk).map((p) => p.split("\\").join("/")).sort();
  // Directories are stamped too: a zip tool that decides to store one still
  // reads its mtime.
  const dirs = new Set(entries.map((e) => dirname(e)).filter((d) => d !== "."));
  for (const rel of [...dirs, ...entries]) utimesSync(join(stage, rel), sourceDate, sourceDate);
  utimesSync(stage, sourceDate, sourceDate);
  rmSync(out, { force: true });
  const run = (cmd, args) => {
    try {
      execFileSync(cmd, args, { cwd: stage, stdio: "inherit" });
      return true;
    } catch (e) {
      if (e.code === "ENOENT") return false;
      throw e;
    }
  };
  if (!run("zip", ["-X", out, ...entries]) && !run(bsdtar, ["-a", "-c", "-f", out, ...entries])) {
    console.error("neither `zip` nor a zip-capable `tar` found — install one and retry");
    process.exit(1);
  }
} finally {
  rmSync(stage, { recursive: true, force: true });
}
console.log(`\npackaged ${out}`);
