#!/usr/bin/env node
// geml codemap find <name> [codemap-dir]
//
// Locate a function/class by (substring, case-insensitive) name in a built
// codemap. Prints each candidate as  <name> \t <doc>#<id> \t <src>  — the
// document + block id to open, and the true source location. NO browser: pure
// stdout, so it pipes/greps. `dir` defaults to ./.geml-code-graph.
//
// Same index the MCP `search_symbols` tool and the viewer search box use
// (_index/name-lookup.json); a name with several rows is real ambiguity
// (overloads / same short name across classes) — every candidate is printed.
//
// The matching rule and the src lookup are IMPORTED, not repeated here: this
// command and `search_symbols` answer the same question, and two copies of
// "what counts as a match" would drift the moment one of them is tuned.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { searchNames, srcOf } from "./mcp-server.mjs";

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
const { names, lookup } = searchNames(dir, query);
if (!names.length) { console.error(`no symbol matching "${query}"`); process.exit(1); }

let n = 0;
for (const name of names) {
  for (const c of lookup[name]) {
    const src = srcOf(dir, c.doc, c.id);
    process.stdout.write(`${name}\t${c.doc}#${c.id}${src ? `\t${src}` : ""}\n`);
    n++;
  }
}
console.error(`\n${n} match(es) for "${query}" across ${names.length} name(s).`);
