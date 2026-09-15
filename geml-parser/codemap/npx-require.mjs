// Resolve libraries that arrive via `npx -y -p <pkg> … node <script>` — the
// hermetic way this toolkit borrows heavyweight dependencies (Volar/svelte2tsx
// for the SFC virtualizer, web-tree-sitter + the grammar bundle for the
// tree-sitter export) without making them dependencies of @geml/geml.
//
// npx does NOT put the -p packages on NODE_PATH; it prepends
// <npm-cache>/_npx/<hash>/node_modules/.bin to PATH. We derive the node_modules
// dir from that PATH entry and createRequire() out of it. Then the project's
// own node_modules, walking up from `startDir` (a checkout that installed the
// packages itself — the test suite does), then the calling script's context.
import { existsSync } from "node:fs";
import { join, dirname, delimiter } from "node:path";
import { createRequire } from "node:module";

// Returns lib(name) -> module | null and lib.path(name) -> resolved file | null.
// `importMetaUrl` is the CALLER's import.meta.url, so the last-resort origin is
// the script that asked, not this helper.
export function makeNpxResolver(startDir, importMetaUrl) {
  const requires = [];
  const npxBin = (process.env.PATH ?? "")
    .split(delimiter)
    .find((p) => /[\\/]_npx[\\/]/.test(p) && /[\\/]\.bin[\\/]?$/.test(p));
  if (npxBin) {
    try { requires.push(createRequire(join(npxBin.replace(/[\\/]\.bin[\\/]?$/, ""), "x.js"))); } catch { /* malformed PATH entry */ }
  }
  for (let d = startDir; ; ) {
    if (existsSync(join(d, "node_modules"))) {
      try { requires.push(createRequire(join(d, "node_modules", "x.js"))); } catch { /* keep walking */ }
    }
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  if (importMetaUrl) {
    try { requires.push(createRequire(importMetaUrl)); } catch { /* no local context */ }
  }
  const lib = (name) => {
    for (const r of requires) { try { return r(name); } catch { /* next origin */ } }
    return null;
  };
  lib.path = (name) => {
    for (const r of requires) { try { return r.resolve(name); } catch { /* next origin */ } }
    return null;
  };
  return lib;
}
