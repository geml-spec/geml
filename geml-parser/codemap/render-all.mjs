#!/usr/bin/env node
// geml codemap render — render every codemap document to a sibling .html.
//
//   geml codemap render <codemap-dir>
//
// The output folder then works with NO server: open index.html straight from
// disk (file://). Module click-through opens each container page inside the
// graph area (nested frame), so the whole map is browsable offline — this is
// the "copy the folder to someone" mode. For a live view that never goes
// stale, use `geml codemap serve` instead.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { parse, renderHtml } from "../dist/geml.js";

const dir = process.argv[2];
if (!dir || dir === "--help") {
  console.error("usage: geml codemap render <codemap-dir>");
  process.exit(2);
}

// One shared cache for the whole batch: every page's graph slice crosses the
// same neighbour documents, and a fresh parse per page turns N pages into
// O(N x working set) — hours at repo scale. A one-shot process has no
// staleness to worry about, so cache unconditionally (the whole codemap's
// text + parsed docs live in memory for the duration of the run).
const texts = new Map();  // rel -> text | null
const parsed = new Map(); // text -> Document
const loadDoc = (rel) => {
  if (!texts.has(rel)) {
    try { texts.set(rel, readFileSync(join(dir, rel), "utf8")); } catch { texts.set(rel, null); }
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
console.error(`rendered ${n} page(s) -> ${dir}${failed.length ? `; FAILED: ${failed.join(", ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
