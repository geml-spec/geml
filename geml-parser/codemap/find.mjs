#!/usr/bin/env node
// geml codemap find <name> [codemap-dir]
//
// Locate a function/class by (substring, case-insensitive) name in a built
// codemap. Prints each candidate as  <name> \t <doc>#<id> \t <src>  — the
// document + block id to open, and the true source location. NO browser: pure
// stdout, so it pipes/greps. `dir` defaults to ./.geml-code-graph.
//
// Same index the MCP `resolve_name` tool and the viewer search box use
// (_index/name-lookup.json); a name with several rows is real ambiguity
// (overloads / same short name across classes) — every candidate is printed.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// `find x | head` closes stdout after a few lines — that is normal pipe
// usage, not an error (POSIX would kill us silently with SIGPIPE; Windows
// node surfaces it as an EPIPE error event): exit quietly instead of
// crashing with an unhandled-error stack trace.
process.stdout.on("error", (e) => { if (e.code === "EPIPE") process.exit(0); throw e; });

const args = process.argv.slice(2);
if (!args.length || args[0] === "--help" || args[0] === "-h") {
  console.error("usage: geml codemap find <name> [codemap-dir]   # locate a symbol by substring name (dir defaults to ./.geml-code-graph)");
  process.exit(args.length ? 0 : 2);
}
const query = args[0];
const dir = args[1] || ".geml-code-graph";
const lookupPath = join(dir, "_index", "name-lookup.json");
if (!existsSync(lookupPath)) {
  console.error(`no name-lookup at ${lookupPath} — build the codemap first (geml codemap build)`);
  process.exit(1);
}
const lookup = JSON.parse(readFileSync(lookupPath, "utf8"));
const q = query.toLowerCase();
const names = Object.keys(lookup).filter((n) => n.toLowerCase().includes(q)).sort();
if (!names.length) { console.error(`no symbol matching "${query}"`); process.exit(1); }

// src= lives on the block header line in the doc; read each doc once, index by id.
const docCache = new Map(); // doc -> Map(id -> src)
const srcOf = (doc, id) => {
  if (!docCache.has(doc)) {
    const map = new Map();
    try {
      const text = readFileSync(join(dir, doc), "utf8");
      // src= may be quoted or a bare token (path#Lx-y, no spaces).
      const re = /\{#([A-Za-z0-9._-]+)\b[^}]*?\bsrc=(?:"([^"]+)"|([^\s}]+))/g;
      let m;
      while ((m = re.exec(text))) map.set(m[1], m[2] || m[3]);
    } catch { /* doc unreadable — skip src */ }
    docCache.set(doc, map);
  }
  return docCache.get(doc).get(id) || "";
};

let n = 0;
for (const name of names) {
  for (const c of lookup[name]) {
    const src = srcOf(c.doc, c.id);
    process.stdout.write(`${name}\t${c.doc}#${c.id}${src ? `\t${src}` : ""}\n`);
    n++;
  }
}
console.error(`\n${n} match(es) for "${query}" across ${names.length} name(s).`);
