#!/usr/bin/env node
// geml-code-graph SFC virtualizer — Vue/Svelte single-file components become
// indexable TypeScript. scip-typescript cannot read .vue/.svelte; this script
// projects each SFC to a shadow TS file (script AND template — an
// @click="save" in a Vue template becomes a real reference to save), plus a
// line-mapping sidecar the scip adapter uses to attribute every symbol back
// to the original .vue/.svelte source. Env-driven like joern-export.sc:
//
//   GEML_SRC  project (sub)root to walk for .vue/.svelte and real TS/JS
//   GEML_OUT  output dir (the "virtual dir"): shadows + sidecars + tsconfig
//
// The build invokes it hermetically — @geml/geml stays zero-dependency:
//   npx -y -p @vue/language-core -p svelte2tsx -p svelte -p typescript@5 \
//       node <abs path to this script>
// npx does NOT put the -p packages on NODE_PATH; it prepends
// <npm-cache>/_npx/<hash>/node_modules/.bin to PATH. We derive the
// node_modules dir from that PATH entry and createRequire() out of it
// (proven on Windows); the target project's own node_modules and this
// script's context are fallbacks, in that order. typescript is pinned @5:
// typescript@latest is 7.x, which @vue/language-core does not accept.
//
// Vue  — @vue/language-core (Volar): createVueLanguagePlugin().createVirtualCode()
//        and the `script_ts|js|tsx|jsx` embedded code, whose text contains the
//        <script> verbatim plus the template projection; its offset mappings
//        [sourceOffsets, generatedOffsets, lengths] become the line map.
// Svelte — svelte2tsx {code, map}: everything lands inside a generated
//        $$render(); the source-map v3 `mappings` VLQ string is decoded here
//        (no dependency) into the same line-map shape.
//
// Per SFC <rel>.vue|.svelte the virtual dir receives:
//   <rel>.<vue|svelte>.<ts|js|tsx|jsx>          the shadow (".vue.ts" naming makes
//                                               `import x from './App.vue'` resolve
//                                               to the shadow by TS extension probing)
//   <rel>.….map.json                            the mapping sidecar:
//     { "version": 1,
//       "original": "src/App.vue",              // posix, relative to GEML_SRC
//       "framework": "vue" | "svelte",
//       "component": "App",                     // basename minus extension
//       "lines": [[generatedLine, originalLine], …],   // 1-based, sorted by
//                                               // generatedLine, first mapping wins;
//                                               // a generated line absent here is
//                                               // PURE GENERATED (never attribute it)
//       "regions": [{ "name": "template", "start": 8, "end": 11 }] }
//                                               // 1-based ORIGINAL line spans of
//                                               // template/markup — a reference whose
//                                               // mapped line falls here but whose
//                                               // caller is generated-only belongs to
//                                               // the synthetic <Component>.template
// plus one sfc-manifest.json ({ src, files:[{shadow, original, map}] }) the
// scip adapter loads, and one synthetic tsconfig.json.
//
// tsconfig include strategy: explicit "files" only (shadows + the project's
// real .ts/.tsx/.js/.jsx via relative paths) — no include globs, so sibling
// virtual dirs, node_modules and build output can never leak in.
// "rootDirs": [".", <rel GEML_SRC>] merges the two trees for RELATIVE import
// resolution: a shadow's `./helper` finds the real <src>/helper.ts, a real
// main.ts's `./App.vue` finds the shadow App.vue.ts. Bare imports (vue,
// svelte) resolve through "paths" → every node_modules dir walking up from
// GEML_SRC, so hoisted monorepo layouts work.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { join, dirname, relative, resolve, basename, delimiter } from "node:path";
import { createRequire } from "node:module";
import { SKIP_DIRS } from "./detect.mjs";

const posix = (p) => p.replace(/\\/g, "/");

// ---- library resolution (npx -p → project → this script) -------------------
function makeResolver(srcAbs) {
  const requires = [];
  const npxBin = (process.env.PATH ?? "")
    .split(delimiter)
    .find((p) => /[\\/]_npx[\\/]/.test(p) && /[\\/]\.bin[\\/]?$/.test(p));
  if (npxBin) {
    try { requires.push(createRequire(join(npxBin.replace(/[\\/]\.bin[\\/]?$/, ""), "x.js"))); } catch { /* malformed PATH entry */ }
  }
  for (let d = srcAbs; ; ) {
    if (existsSync(join(d, "node_modules"))) {
      try { requires.push(createRequire(join(d, "node_modules", "x.js"))); } catch { /* keep walking */ }
    }
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  try { requires.push(createRequire(import.meta.url)); } catch { /* no local context */ }
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

// ---- shared line helpers ----------------------------------------------------
// offset -> 0-based line, O(log n) over precomputed line starts.
function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return (off) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; }
    return lo;
  };
}

// Volar offset mappings -> [[genLine, origLine], …] (1-based). A multi-line
// mapping segment is a verbatim copy, so lines advance in lockstep.
function linePairsFromVolar(srcText, genText, mappings) {
  const srcLine = lineIndex(srcText), genLine = lineIndex(genText);
  const triples = [];
  for (const m of mappings) {
    for (let i = 0; i < m.sourceOffsets.length; i++) {
      triples.push([m.sourceOffsets[i], m.generatedOffsets[i], m.lengths?.[i] ?? 0]);
    }
  }
  triples.sort((a, b) => a[1] - b[1]);
  const pairs = new Map(); // genLine0 -> origLine0, first mapping wins
  for (const [s, g, l] of triples) {
    const g0 = genLine(g), s0 = srcLine(s);
    const span = genLine(g + Math.max(l - 1, 0)) - g0;
    for (let k = 0; k <= span; k++) if (!pairs.has(g0 + k)) pairs.set(g0 + k, s0 + k);
  }
  return [...pairs.entries()].sort((a, b) => a[0] - b[0]).map(([g, s]) => [g + 1, s + 1]);
}

// Source-map v3 `mappings` VLQ -> [[genLine, origLine], …] (1-based). Tiny
// hand-rolled base64-VLQ decoder — per generated line the FIRST segment that
// names a source line wins. Fields per segment: [genCol, srcIdx, srcLine,
// srcCol, name]; all deltas except genCol carry across lines.
function linePairsFromV3(mappings) {
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const val = new Map([...B64].map((c, i) => [c, i]));
  const pairs = [];
  let srcIdx = 0, srcLine = 0, srcCol = 0, name = 0;
  const rows = String(mappings).split(";");
  for (let g = 0; g < rows.length; g++) {
    let taken = false;
    for (const seg of rows[g].split(",")) {
      if (!seg) continue;
      const fields = [];
      let shift = 0, cur = 0;
      for (const ch of seg) {
        const d = val.get(ch);
        cur |= (d & 31) << shift;
        if (d & 32) { shift += 5; continue; }
        fields.push(cur & 1 ? -(cur >>> 1) : cur >>> 1);
        shift = 0; cur = 0;
      }
      if (fields.length >= 4) {
        srcIdx += fields[1]; srcLine += fields[2]; srcCol += fields[3];
        if (fields.length >= 5) name += fields[4];
        if (!taken) { pairs.push([g + 1, srcLine + 1]); taken = true; }
      }
    }
  }
  return pairs;
}

// ---- walk --------------------------------------------------------------------
function walk(rootAbs) {
  const sfc = [], real = [];
  const rec = (dir) => {
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) rec(join(dir, e.name));
        continue;
      }
      if (!e.isFile()) continue;
      const rel = posix(relative(rootAbs, join(dir, e.name)));
      if (/\.(vue|svelte)$/i.test(e.name)) sfc.push(rel);
      else if (/\.(ts|tsx|js|jsx)$/i.test(e.name) && !e.name.endsWith(".d.ts")) real.push(rel);
    }
  };
  rec(rootAbs);
  return { sfc: sfc.sort(), real: real.sort() };
}

// ---- vue ---------------------------------------------------------------------
function makeVue(lib) {
  const ts = lib("typescript");
  const core = lib("@vue/language-core");
  if (!ts || !core) return null;
  const vueOptions = core.resolveVueCompilerOptions
    ? core.resolveVueCompilerOptions({})           // language-core 2.x
    : core.getDefaultCompilerOptions();            // language-core 3.x
  const plugin = core.createVueLanguagePlugin(ts, { allowJs: true }, vueOptions, (id) => id);
  return (absPosix, text) => {
    const code = plugin.createVirtualCode(absPosix, "vue", ts.ScriptSnapshot.fromString(text));
    if (!code) throw new Error("not a valid vue file for this plugin");
    let embedded;
    for (const ec of core.forEachEmbeddedCode(code)) {
      if (/^script_(ts|tsx|js|jsx)$/.test(ec.id)) { embedded = ec; break; }
    }
    if (!embedded) throw new Error("no script embedded code produced");
    const gen = embedded.snapshot.getText(0, embedded.snapshot.getLength());
    const regions = [];
    const tpl = code.vueSfc?.descriptor?.template?.loc;
    if (tpl) regions.push({ name: "template", start: tpl.start.line, end: tpl.end.line });
    else {
      // parse-less fallback: the top-level <template> block by text position
      const idx = lineIndex(text);
      const open = text.search(/<template[\s>]/);
      const close = text.lastIndexOf("</template>");
      if (open >= 0 && close > open) regions.push({ name: "template", start: idx(open) + 1, end: idx(close) + 1 });
    }
    return {
      ext: embedded.id.slice("script_".length),
      gen,
      lines: linePairsFromVolar(text, gen, embedded.mappings),
      regions,
    };
  };
}

// ---- svelte ------------------------------------------------------------------
function makeSvelte(lib) {
  const mod = lib("svelte2tsx");
  if (!mod) return null;
  const svelte2tsx = mod.svelte2tsx ?? mod;
  return (absPosix, text) => {
    const isTsFile = /<script[^>]*\blang\s*=\s*["']?ts/.test(text);
    const out = svelte2tsx(text, { filename: absPosix, isTsFile, mode: "ts" });
    // markup = every line outside top-level <script>/<style> blocks, trimmed
    // to its non-blank extent; a component may hold several disjoint spans.
    const idx = lineIndex(text);
    const total = idx(text.length) + 1;
    const blocked = new Array(total).fill(false);
    for (const m of text.matchAll(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/g)) {
      const a = idx(m.index), b = idx(m.index + m[0].length - 1);
      for (let i = a; i <= b; i++) blocked[i] = true;
    }
    const srcLines = text.split("\n");
    const regions = [];
    for (let i = 0; i < total; i++) {
      if (blocked[i] || !srcLines[i]?.trim()) continue;
      let j = i;
      while (j + 1 < total && !blocked[j + 1]) j++;
      while (j > i && !srcLines[j]?.trim()) j--;
      regions.push({ name: "template", start: i + 1, end: j + 1 });
      i = j;
    }
    return { ext: "ts", gen: out.code, lines: linePairsFromV3(out.map.mappings), regions };
  };
}

// ---- main --------------------------------------------------------------------
const srcAbs = resolve(process.env.GEML_SRC ?? ".");
const outAbs = resolve(process.env.GEML_OUT ?? "");
if (!process.env.GEML_OUT) {
  console.error("sfc-virtualize: GEML_OUT (output dir) is required; GEML_SRC defaults to cwd");
  process.exit(2);
}

const lib = makeResolver(srcAbs);
const { sfc, real } = walk(srcAbs);
if (!sfc.length) {
  console.error(`sfc-virtualize: no .vue/.svelte files under ${srcAbs} — nothing to do`);
  process.exit(1);
}

let vue = null, svelte = null;
const missing = [];
if (sfc.some((f) => /\.vue$/i.test(f))) {
  vue = makeVue(lib);
  if (!vue) missing.push("@vue/language-core (+ typescript@5)");
}
if (sfc.some((f) => /\.svelte$/i.test(f))) {
  svelte = makeSvelte(lib);
  if (!svelte) missing.push("svelte2tsx (+ svelte)");
}
if (missing.length) {
  console.error(
    `sfc-virtualize: cannot resolve ${missing.join(" and ")} — run via\n`
    + "  npx -y -p @vue/language-core -p svelte2tsx -p svelte -p typescript@5 node <this script>\n"
    + "or install them in the target project.",
  );
  process.exit(1);
}

mkdirSync(outAbs, { recursive: true });
const manifest = [];
let nVue = 0, nSvelte = 0, failed = 0;
for (const rel of sfc) {
  const absPosix = posix(join(srcAbs, rel));
  try {
    const text = readFileSync(join(srcAbs, rel), "utf8");
    const isVue = /\.vue$/i.test(rel);
    const r = (isVue ? vue : svelte)(absPosix, text);
    const shadowRel = `${rel}.${r.ext}`;
    const shadowAbs = join(outAbs, shadowRel);
    mkdirSync(dirname(shadowAbs), { recursive: true });
    writeFileSync(shadowAbs, r.gen);
    const mapRel = `${shadowRel}.map.json`;
    writeFileSync(join(outAbs, mapRel), JSON.stringify({
      version: 1,
      original: rel,
      framework: isVue ? "vue" : "svelte",
      component: basename(rel).replace(/\.(vue|svelte)$/i, ""),
      lines: r.lines,
      regions: r.regions,
    }));
    manifest.push({ shadow: shadowRel, original: rel, map: mapRel });
    isVue ? nVue++ : nSvelte++;
  } catch (e) {
    failed++;
    console.error(`sfc-virtualize: FAILED ${rel}: ${e.message}`);
  }
}

if (!manifest.length) {
  console.error("sfc-virtualize: every SFC failed to virtualize — nothing to index");
  process.exit(1);
}

// svelte2tsx global shims (svelteHTML etc) — cosmetic for indexing (user
// symbols resolve without them) but cheap to include when findable.
const extraFiles = [];
if (nSvelte) {
  for (const shim of ["svelte2tsx/svelte-shims-v4.d.ts", "svelte2tsx/svelte-shims.d.ts"]) {
    const p = lib.path(shim);
    if (p) {
      try {
        copyFileSync(p, join(outAbs, "svelte-shims.d.ts"));
        extraFiles.push("svelte-shims.d.ts");
      } catch { /* optional */ }
      break;
    }
  }
}

const relSrc = posix(relative(outAbs, srcAbs)) || ".";
const nmPaths = [];
for (let d = srcAbs; ; ) {
  if (existsSync(join(d, "node_modules"))) nmPaths.push(`${posix(relative(outAbs, join(d, "node_modules")))}/*`);
  const up = dirname(d);
  if (up === d) break;
  d = up;
}
writeFileSync(join(outAbs, "tsconfig.json"), JSON.stringify({
  compilerOptions: {
    allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true,
    module: "esnext", target: "esnext", moduleResolution: "node",
    jsx: "preserve", baseUrl: ".",
    rootDirs: [".", relSrc],
    ...(nmPaths.length ? { paths: { "*": nmPaths } } : {}),
  },
  files: [
    ...manifest.map((m) => m.shadow),
    ...extraFiles,
    ...real.map((f) => `${relSrc}/${f}`),
  ],
}, null, 2));

writeFileSync(join(outAbs, "sfc-manifest.json"), JSON.stringify({
  version: 1,
  src: posix(srcAbs),
  files: manifest,
}, null, 2));

console.error(
  `sfc-virtualize: ${manifest.length} shadow(s) (${nVue} vue, ${nSvelte} svelte)`
  + `${failed ? `, ${failed} FAILED` : ""}, ${real.length} real source file(s) -> ${outAbs}`,
);
