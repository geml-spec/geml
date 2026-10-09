#!/usr/bin/env node
// logseq-any-sync — keep an Anytype space and a folder of GEML pages in step.

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { syncOnce } from "../../core/src/engine.mjs";
import { anytypeAdapter, AnytypeUnavailable } from "../../adapters/anytype/index.mjs";

const USAGE = `logseq-any-sync — an Anytype space ⇄ a git-friendly folder of GEML pages.

Usage:
  logseq-any-sync <vault-dir> --space <space-id> [flags]
  logseq-any-sync doctor --space <space-id>

Every Anytype object is a page in <vault-dir>/pages/, every block addressable
by its id; every page has a .gemlhistory change graph beside it. Edits on
either side are merged block by block; where both sides changed one block, the
later edit wins and the other is reported (it stays in the history).

Environment:
  ANYTYPE_API_KEY   required — pair it in the Anytype app; it is sent only to
                    the local API
  ANYTYPE_SPACE     the space, instead of --space
  ANYTYPE_API_URL   the local API (default http://127.0.0.1:31009)
  GEML_AUTHOR       the author recorded on vault edits (default: vault)

Flags:
  --space <id>        the Anytype space to mirror
  --once              one cycle, then exit (default: keep watching)
  --interval <s>      seconds between cycles (default 2)
  --dry-run           show what would be sent; write and send nothing
  --markdown <dir>    also write the pages as Markdown to <dir>, one way
  --no-git-commit     never commit (default: commit when the vault is a git repository)
  --api <url>         the local API, instead of ANYTYPE_API_URL
`;

function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) fail(`${name} needs a value`);
  return v;
}

function fail(msg, code = 2) {
  console.error(`logseq-any-sync: ${msg}`);
  process.exit(code);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h") || args.length === 0) { console.log(USAGE); process.exit(args.length ? 0 : 2); }

const known = new Set(["--space", "--once", "--interval", "--dry-run", "--markdown", "--no-git-commit", "--api"]);
const valued = new Set(["--space", "--interval", "--markdown", "--api"]);
const positionals = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith("--")) {
    if (!known.has(a)) fail(`unknown flag ${a}\n\n${USAGE}`);
    if (valued.has(a)) i++;
    continue;
  }
  positionals.push(a);
}

const apiKey = process.env.ANYTYPE_API_KEY;
const space = flag(args, "--space") ?? process.env.ANYTYPE_SPACE;
const baseUrl = flag(args, "--api") ?? process.env.ANYTYPE_API_URL ?? "http://127.0.0.1:31009";
if (!apiKey) fail("set ANYTYPE_API_KEY to an API key paired in the Anytype desktop app");
if (!space) fail("name the space: --space <space-id> or ANYTYPE_SPACE");
const adapter = anytypeAdapter({ baseUrl, apiKey, space });

if (positionals[0] === "doctor") {
  try {
    const page = await adapter.api.listObjects({ limit: 1, fields: "last_modified_date" });
    const row = page.data?.[0];
    console.log(`ok: reached ${baseUrl}, space ${space} lists ${page.total ?? "?"} object(s)`);
    console.log(row?.properties?.last_modified_date !== undefined
      ? "ok: object rows carry last_modified_date — each cycle reads only what changed"
      : "note: object rows carry no last_modified_date — each cycle reads every object and compares etags");
    process.exit(0);
  } catch (e) {
    fail(e.message, 1);
  }
}

const vaultArg = positionals[0];
if (!vaultArg) fail(`name the vault directory\n\n${USAGE}`);
const vault = resolve(vaultArg);
mkdirSync(vault, { recursive: true });
const once = args.includes("--once");
const dryRun = args.includes("--dry-run");
const interval = Number(flag(args, "--interval") ?? 2);
if (!(interval > 0)) fail("--interval takes a positive number of seconds");
const markdownDir = flag(args, "--markdown");

function print(r) {
  const t = new Date().toLocaleTimeString();
  const parts = [];
  if (r.pulled.length) parts.push(`${r.pulled.length} pulled`);
  if (r.pushed.length) parts.push(`${r.pushed.length} pushed`);
  if (r.created.length) parts.push(`${r.created.length} new page(s)`);
  if (r.published.length) parts.push(`${r.published.length} created in Anytype`);
  if (parts.length) console.log(`[${t}] ${parts.join(", ")}${r.git?.committed ? " — committed" : ""}`);
  for (const h of r.held) console.log(`  held ${h.file}: ${h.why}`);
  for (const l of r.lost) console.log(`  ⚠ ${l}`);
  for (const p of r.planned) {
    console.log(`  would send to ${p.file}:`);
    for (const op of p.ops) console.log(`    ${JSON.stringify(op)}`);
  }
}

let waiting = false;
let stop = false;
process.on("SIGINT", () => { stop = true; });
for (;;) {
  try {
    const r = await syncOnce({ vault, adapter, dryRun, author: process.env.GEML_AUTHOR, commit: !args.includes("--no-git-commit"), markdownDir: markdownDir && resolve(markdownDir) });
    waiting = false;
    print(r);
  } catch (e) {
    if (!(e instanceof AnytypeUnavailable)) fail(e.message, 1);
    if (once) fail(e.message, 1);
    if (!waiting) console.log(`[${new Date().toLocaleTimeString()}] ${e.message} — waiting`);
    waiting = true;
  }
  if (once || dryRun || stop) break;
  await new Promise((r) => setTimeout(r, interval * 1000));
  if (stop) break;
}
