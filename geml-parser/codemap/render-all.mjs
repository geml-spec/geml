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

const loadDoc = (rel) => {
  try { return readFileSync(join(dir, rel), "utf8"); } catch { return null; }
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
    const doc = parse(readFileSync(join(dir, f), "utf8"));
    const html = renderHtml(doc, { source: basename(f), loadDoc, parseDoc: (s) => parse(s) });
    writeFileSync(join(dir, f.replace(/\.geml$/, ".html")), html);
    n++;
  } catch (e) {
    failed.push(f);
    console.error(`render: ${f}: ${e.message}`);
  }
}
console.error(`rendered ${n} page(s) -> ${dir}${failed.length ? `; FAILED: ${failed.join(", ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
