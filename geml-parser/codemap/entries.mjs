// geml-code-graph app-entry detection — WHERE does this repo start running?
//
// Emits entry HINTS ({ file, via, name? }) from three signal tiers, each
// carrying an honest `via` label (the codemap never claims an entry without
// saying what convention identified it):
//   L2 manifest/layout   Cargo [[bin]] & src/main.rs & src/bin/*, package.json
//                        bin, wrangler.toml main, Nuxt app.vue, Next root
//                        page, SvelteKit root route, Django manage.py,
//                        python __main__.py
//   L3 source markers    workers-rs #[event(...)], createApp().mount() /
//                        createRoot() / svelte mount (SPA bootstraps),
//                        .listen() (node servers), export default { fetch }
//                        (JS workers), Flask()/FastAPI() apps,
//                        @SpringBootApplication
// (L1 — a function literally named `main` — is already flagged by the scip
// and joern adapters at extraction time; hints here ADD to it.)
//
// Pure by design: given precomputed { files, manifests, pkgs } lists it walks
// nothing; `readText`/`readJson` are injectable, and every source peek is
// bounded to a handful of conventional entry files per project — never a
// repo-wide grep. A hint is only emitted for files the build actually indexes
// (present in `files`), so a pkg-bin pointing at dist/ never leaks in.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

export function detectEntries(root, { files = [], manifests = [], pkgs = [], readText, readJson } = {}) {
  readText ??= (p) => readFileSync(p, "utf8");
  readJson ??= (p) => JSON.parse(readText(p));
  const fileSet = new Set(files);
  const hints = [];
  const seen = new Set();
  const add = (file, via, name) => {
    if (!file || !fileSet.has(file)) return;
    const k = `${file}${via}${name ?? ""}`;
    if (seen.has(k)) return;
    seen.add(k);
    hints.push(name ? { file, via, name } : { file, via });
  };
  const tryText = (rel) => {
    try { return readText(join(root, ...rel.split("/"))); } catch { return null; }
  };

  // ---- Rust: cargo bin targets + workers-rs event handlers ----
  for (const m of manifests.filter((x) => x.endsWith("Cargo.toml"))) {
    const dir = dirOf(m);
    const at = (rel) => (dir ? `${dir}/${rel}` : rel);
    add(at("src/main.rs"), "cargo-bin", "main");
    for (const f of files) if (f.startsWith(at("src/bin/")) && f.endsWith(".rs")) add(f, "cargo-bin", "main");
    const toml = tryText(m);
    if (toml) {
      for (const b of toml.matchAll(/^\[\[bin\]\][^[]*/gm)) {
        const p = /path\s*=\s*"([^"]+)"/.exec(b[0]);
        if (p) add(at(p[1].replace(/\\/g, "/")), "cargo-bin", "main");
      }
    }
    for (const rel of ["src/main.rs", "src/lib.rs"]) {
      const t = fileSet.has(at(rel)) ? tryText(at(rel)) : null;
      if (!t) continue;
      for (const ev of t.matchAll(/#\[event\((\w+)[^)]*\)\]\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
        add(at(rel), `worker-${ev[1]}`, ev[2]);
      }
    }
  }

  // ---- Node/TS/frontends: one look per package ----
  for (const p of pkgs) {
    const dir = dirOf(p);
    const at = (rel) => (dir ? `${dir}/${rel}` : rel);
    let pkg = {};
    try { pkg = readJson(join(root, ...p.split("/"))) ?? {}; } catch { /* unreadable manifest */ }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const norm = (v) => (typeof v === "string" ? v.replace(/^\.\//, "").replace(/\\/g, "/") : null);
    const bins = typeof pkg.bin === "string" ? [pkg.bin] : Object.values(pkg.bin ?? {});
    for (const b of bins) { const f = norm(b); if (f) add(at(f), "pkg-bin"); }
    const wrangler = tryText(at("wrangler.toml"));
    if (wrangler) {
      const mm = /^\s*main\s*=\s*"([^"]+)"/m.exec(wrangler);
      if (mm) add(at(norm(mm[1])), "worker-fetch");
    }
    // Nuxt: the app shell is the entry; individual pages are routes, not
    // program starts — deliberately NOT flooded into app-entries.
    if (deps.nuxt || fileSet.has(at("nuxt.config.ts")) || fileSet.has(at("nuxt.config.js"))) {
      if (fileSet.has(at("app.vue"))) add(at("app.vue"), "nuxt-app");
      else add(at("pages/index.vue"), "nuxt-page");
    }
    if (deps.next) {
      for (const rel of ["app/page.tsx", "app/page.jsx", "src/app/page.tsx", "pages/index.tsx", "pages/index.jsx", "src/pages/index.tsx"]) {
        if (fileSet.has(at(rel))) { add(at(rel), "next-page"); break; }
      }
    }
    if (deps["@sveltejs/kit"]) add(at("src/routes/+page.svelte"), "kit-route");
    // SPA bootstrap / server start markers — conventional entry files only.
    for (const rel of ["src/main.ts", "src/main.tsx", "src/main.js", "src/main.jsx",
      "src/index.ts", "src/index.tsx", "src/index.js", "index.ts", "index.js",
      "src/server.ts", "src/server.js", "server.js", "src/app.ts", "app.js"]) {
      const f = at(rel);
      if (!fileSet.has(f)) continue;
      const t = tryText(f);
      if (!t) continue;
      if (/createApp\s*\(/.test(t) && /\.mount\s*\(/.test(t)) add(f, "vue-mount");
      else if (/createRoot\s*\(|ReactDOM\.render\s*\(/.test(t)) add(f, "react-mount");
      else if (deps.svelte && /\bnew\s+\w+\s*\(\s*\{[^}]*target|\bmount\s*\(/.test(t)) add(f, "svelte-mount");
      if (/\.listen\s*\(/.test(t)) add(f, "server-listen");
      if (/export\s+default\s*\{[^}]*\bfetch\b/s.test(t)) add(f, "worker-fetch");
    }
  }

  // ---- Python ----
  for (const f of files) {
    if (/(^|\/)manage\.py$/.test(f)) add(f, "django-manage");
    else if (/(^|\/)__main__\.py$/.test(f)) add(f, "py-main");
    else if (/(^|\/)(app|main|wsgi|asgi)\.py$/.test(f)) {
      const t = tryText(f);
      if (t && /\bFlask\s*\(|\bFastAPI\s*\(/.test(t)) add(f, "wsgi-app");
    }
  }

  // ---- Java: Spring Boot (convention-named files only, never a repo grep) ----
  for (const f of files) {
    if (/Application\.java$/.test(f)) {
      const t = tryText(f);
      if (t && /@SpringBootApplication/.test(t)) add(f, "spring-boot", "main");
    }
  }

  return hints;
}
