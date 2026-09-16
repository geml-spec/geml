#!/usr/bin/env node
// vault-graph — the link graph of a Markdown vault, reported by BLOCK ADDRESS.
//
//   node vault-graph.mjs <dir|file> [more…] [--json] [--quiet]
//
// Answers the two questions a wiki lint asks and `grep` answers badly:
// which pages nothing links to, and which links point at nothing. Every dead
// link is reported with the address of the block holding it, so the fix is
// `geml set <file> '<address>'` rather than a hunt through the page.
//
// Why this goes through the parser instead of grepping for `[[`: a wikilink
// inside a ```dataview fence, or inside `inline code`, is not a link — Obsidian
// does not render it and neither does its graph. Block structure comes from
// `geml list`, which reads Markdown directly; fence state is then tracked
// WITHIN a block's own lines, because a fence is not itself an addressable
// block in Markdown mode.
//
// Frontmatter counts. `related: - "[[index]]"` is a real edge in Obsidian's
// graph, and it lives in the anonymous block at the top of the page, which
// `geml list` reports like any other.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// Directories that are never vault content. `.raw/` and other dot-directories
// ARE walked: a vault that hides its sources from Obsidian's file explorer
// still wants them counted, and the caller chose which roots to name.
const SKIP_DIRS = new Set(["node_modules", ".git", ".obsidian", ".trash", ".stfolder"]);

// The CLI to drive: an explicit override first, then this checkout's build,
// then whatever `geml` is on PATH.
function cliArgv() {
  if (process.env.GEML_CLI) return [process.env.GEML_CLI];
  const local = resolve(HERE, "..", "..", "..", "geml-parser", "dist", "geml.js");
  try { statSync(local); return [local]; } catch { return null; }
}

function listBlocks(file) {
  const cli = cliArgv();
  const r = cli
    ? spawnSync(process.execPath, [...cli, "list", file, "--json"], { encoding: "utf8" })
    : spawnSync("geml", ["list", file, "--json"], { encoding: "utf8", shell: process.platform === "win32" });
  if (r.error || r.status !== 0) {
    throw new Error(`geml list failed on ${file}: ${(r.stderr || r.error?.message || "").trim()}`);
  }
  return JSON.parse(r.stdout);
}

function mdFilesUnder(path, out) {
  let dir = false;
  try { dir = statSync(path).isDirectory(); } catch { return; }
  if (!dir) { if (extname(path).toLowerCase() === ".md") out.push(path); return; }
  for (const e of readdirSync(path, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (SKIP_DIRS.has(e.name)) continue;
    mdFilesUnder(join(path, e.name), out);
  }
}

function everyFileUnder(path, out) {
  let dir = false;
  try { dir = statSync(path).isDirectory(); } catch { return; }
  if (!dir) { out.push(path); return; }
  for (const e of readdirSync(path, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (SKIP_DIRS.has(e.name)) continue;
    everyFileUnder(join(path, e.name), out);
  }
}

// A fence opens with three or more backticks or tildes and closes with at least
// as many of the same character. Everything between is code, whatever it holds.
const FENCE = /^\s*(`{3,}|~{3,})/;
const INLINE_CODE = /`[^`\n]*`/g;
const WIKILINK = /!?\[\[([^\]\n|#]*)([^\]\n]*)\]\]/g;

// The links a block really contributes: fenced code dropped whole, inline code
// blanked, then every `[[target]]` / `![[target]]` reduced to its target.
function linksIn(lines) {
  const found = [];
  let fence = null;
  for (const raw of lines) {
    const m = FENCE.exec(raw);
    if (fence) { if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null; continue; }
    if (m) { fence = m[1]; continue; }
    const line = raw.replace(INLINE_CODE, (s) => " ".repeat(s.length));
    for (const hit of line.matchAll(WIKILINK)) {
      // `[[#heading]]` and `[[|alias]]` name no document — an intra-page jump.
      const target = hit[1].trim();
      if (target) found.push(target);
    }
  }
  return found;
}

// `geml list` reports nested blocks: a heading's span CONTAINS the spans of the
// blocks under it, so a link inside a subsection appears in two or three rows.
// Attribute every line to the SMALLEST block holding it — the same rule
// `geml find` uses, and the reason an address it prints is one you can edit.
function ownLines(blocks, src) {
  const owner = new Array(src.length).fill(null);
  const size = (b) => b.lines[1] - b.lines[0];
  for (const b of blocks) {
    for (let i = b.lines[0] - 1; i < b.lines[1] && i < src.length; i++) {
      if (owner[i] === null || size(b) < size(owner[i])) owner[i] = b;
    }
  }
  const grouped = new Map();
  for (let i = 0; i < src.length; i++) {
    if (!owner[i]) continue;
    const key = owner[i].address;
    if (!grouped.has(key)) grouped.set(key, [owner[i], []]);
    grouped.get(key)[1].push(src[i]);
  }
  return [...grouped.values()];
}

function build(roots) {
  const pages = [];
  for (const r of roots) mdFilesUnder(resolve(r), pages);
  const assets = [];
  for (const r of roots) everyFileUnder(resolve(r), assets);
  const base = roots.length === 1 ? resolve(roots[0]) : process.cwd();
  const rel = (p) => relative(base, p).split(sep).join("/");

  // Two resolution tables, because Obsidian resolves two ways: a bare name by
  // basename across the whole vault, and a name holding `/` by path.
  const byName = new Map();   // "Note Name" (no .md) -> [relpath]
  const byPath = new Map();   // "folder/Note Name"   -> relpath
  for (const p of pages) {
    const r = rel(p);
    const stem = r.replace(/\.md$/i, "");
    byPath.set(stem, r);
    const name = stem.split("/").pop();
    byName.set(name, [...(byName.get(name) ?? []), r]);
  }
  // Attachments: `![[cover.png]]` and `![[dash.base]]` name real files that are
  // not pages. Counting them as dead links would bury the real ones. Obsidian
  // resolves a bare name against any file type, so `[[Wiki Map]]` finds
  // `Wiki Map.canvas` — the stem table is what keeps that out of `dead`.
  // Pages are resolved by the tables above and must NOT appear here: a `.md`
  // stem in the attachment table would make every link to a page look like a
  // link to a file, and every page an orphan.
  const attach = assets.map(rel).filter((r) => extname(r).toLowerCase() !== ".md");
  const assetNames = new Set(attach.map((r) => r.split("/").pop()));
  const assetPaths = new Set(attach);
  const assetStems = new Set(attach.map((r) => r.split("/").pop().replace(/\.[^.]+$/, "")));

  const out = new Map(pages.map((p) => [rel(p), []]));
  const inbound = new Map(pages.map((p) => [rel(p), new Set()]));
  const dead = [];
  const ambiguous = [];

  for (const p of pages) {
    const from = rel(p);
    const src = readFileSync(p, "utf8").split(/\r?\n/);
    for (const [b, lines] of ownLines(listBlocks(p), src)) {
      for (const target of linksIn(lines)) {
        const hits = target.includes("/")
          ? (byPath.has(target) ? [byPath.get(target)] : [])
          : (byName.get(target) ?? []);
        if (hits.length === 0) {
          // Pages first, attachments second: a vault holding both `dashboard.md`
          // and `dashboard.base` resolves a bare `[[dashboard]]` to the page.
          if (assetPaths.has(target) || assetNames.has(target) || assetStems.has(target)) continue;
          dead.push({ from, address: b.address, target });
          continue;
        }
        if (hits.length > 1) ambiguous.push({ from, address: b.address, target, candidates: hits });
        const to = hits[0];
        out.get(from).push({ address: b.address, target, to });
        if (to !== from) inbound.get(to).add(from);
      }
    }
  }

  const orphans = [...inbound].filter(([, from]) => from.size === 0).map(([p]) => p).sort();
  return {
    pages: [...out].map(([path, outbound]) => ({
      path, outbound, inbound: [...inbound.get(path)].sort(),
    })).sort((a, b) => (a.path < b.path ? -1 : 1)),
    orphans,
    dead: dead.sort((a, b) => (a.from + a.target < b.from + b.target ? -1 : 1)),
    ambiguous,
  };
}

function main(argv) {
  const roots = argv.filter((a) => !a.startsWith("--"));
  if (roots.length === 0) {
    console.error("usage: vault-graph.mjs <dir|file> [more…] [--json] [--quiet]");
    console.error("  reports orphan pages and dead wikilinks; each dead link carries the");
    console.error("  BLOCK ADDRESS holding it, so the fix is `geml set <file> '<address>'`.");
    process.exit(2);
  }
  const g = build(roots);
  if (argv.includes("--json")) { console.log(JSON.stringify(g, null, 2)); }
  else if (!argv.includes("--quiet")) {
    console.log(`${g.pages.length} page(s), ${g.orphans.length} orphan(s), ${g.dead.length} dead link(s)`);
    for (const o of g.orphans) console.log(`orphan\t${o}`);
    for (const d of g.dead) console.log(`dead\t${d.from}\t${d.address}\t[[${d.target}]]`);
    for (const a of g.ambiguous) console.log(`ambiguous\t${a.from}\t${a.address}\t[[${a.target}]]\t${a.candidates.join(" | ")}`);
  }
  // Exit 1 when the vault has something to fix, so this works in a script.
  process.exit(g.dead.length > 0 ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2));
}

export { build, linksIn };
