#!/usr/bin/env node
// geml codemap render — render every codemap document to a sibling .html.
//
//   geml codemap render [codemap-dir]
//
// The output folder then works with NO server: open index.html straight from
// disk (file://). Module click-through opens each container page inside the
// graph area (nested frame), so the whole map is browsable offline — this is
// the "copy the folder to someone" mode. For a live view that never goes
// stale, use `geml codemap serve` instead.
import { readdirSync, readFileSync, writeFileSync, realpathSync, unlinkSync } from "node:fs";
import { join, basename, sep, resolve as resolvePath } from "node:path";
import { parse, renderHtml } from "../dist/geml.js";

if (process.argv[2] === "--help" || process.argv[2] === "-h") {
  console.error("usage: geml codemap render [codemap-dir]   (dir defaults to ./.geml-code-graph)");
  process.exit(2);
}
const dir = process.argv[2] || ".geml-code-graph";

// One shared cache for the whole batch: every page's graph slice crosses the
// same neighbour documents, and a fresh parse per page turns N pages into
// O(N x working set) — hours at repo scale. A one-shot process has no
// staleness to worry about, so cache unconditionally (the whole codemap's
// text + parsed docs live in memory for the duration of the run).
const texts = new Map();  // rel -> text | null
const parsed = new Map(); // text -> Document
// `rel` is document-controlled — a `src=` composed by the renderer — and the
// output of this command is a published artifact, so an unconfined read here
// writes any .geml on the filesystem into a file that then gets served. Gate on
// the realpath, the same shape `serve` and the CLI resolver use.
let realDir = null;
try { realDir = realpathSync(resolvePath(dir)); } catch { realDir = null; }
const loadDoc = (rel) => {
  if (!texts.has(rel)) {
    let text = null;
    if (realDir !== null) {
      try {
        const real = realpathSync(join(dir, rel));
        if (real === realDir || real.startsWith(realDir + sep)) text = readFileSync(real, "utf8");
      } catch { text = null; }
    }
    texts.set(rel, text);
  }
  return texts.get(rel);
};
const parseDoc = (s) => {
  let d = parsed.get(s);
  if (!d) { d = parse(s); parsed.set(s, d); }
  return d;
};

let n = 0;
const failed = [];
let files;
try {
  files = readdirSync(dir);
} catch {
  console.error(`error: cannot read directory ${dir}`);
  process.exit(1);
}
for (const f of files) {
  if (!f.endsWith(".geml")) continue;
  try {
    const text = loadDoc(f);
    if (text === null) throw new Error("unreadable");
    const doc = parseDoc(text);
    const html = renderHtml(doc, { source: basename(f), loadDoc, parseDoc });
    writeFileSync(join(dir, f.replace(/\.geml$/, ".html")), html);
    n++;
  } catch (e) {
    failed.push(f);
    console.error(`render: ${f}: ${e.message}`);
  }
}
// Each tool prunes what it owns: build removes the documents it no longer
// produces, and this removes the pages whose document is gone. An orphan page
// is worse than a stale one — it is unreachable from index.html yet still
// served, so a copied folder ships a page describing deleted code with no way
// to notice. Only a `<base>.html` whose `<base>.geml` is absent qualifies, so
// nothing that has a document behind it is ever touched.
const prunedPages = [];
for (const f of files) {
  if (!f.endsWith(".html")) continue;
  if (files.includes(f.replace(/\.html$/, ".geml"))) continue;
  try { unlinkSync(join(dir, f)); prunedPages.push(f); } catch { /* already gone */ }
}
console.error(`rendered ${n} page(s) -> ${dir}${failed.length ? `; FAILED: ${failed.join(", ")}` : ""}`);
if (prunedPages.length) console.error(`  pruned ${prunedPages.length} orphan page(s): ${prunedPages.join(", ")}`);
process.exit(failed.length ? 1 : 0);
