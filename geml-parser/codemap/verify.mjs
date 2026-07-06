#!/usr/bin/env node
// geml-code-graph verify — the codemap's correctness oracle, two passes:
//
//   1. `geml check` over every .geml (document structure, id uniqueness,
//      native references).
//   2. The codemap-profile pass (docs/codemap-profile.md): CSV cells and meta
//      values are opaque to the GEML standard BY DESIGN (the standard stays
//      untouched), so edge integrity is checked here — the from/to columns of
//      #calls / #called-by / #ref-by tables and every meta `entry` value must
//      resolve (`#id` in the same document, `doc.geml#id` in a sibling).
//      A renamed or deleted method therefore fails the build, not the reader.
//
//   geml codemap verify <dir> [--geml <path-to-geml.js|geml>]
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("-"));
const flagI = args.indexOf("--geml");
if (!dir) {
  console.error("usage: geml codemap verify <dir> [--geml <path>]");
  process.exit(2);
}
const rootDir = resolve(dir);

// Resolve the geml CLI (pass 1) and the parser API (pass 2).
const localParser = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/geml.js");
let cli = flagI >= 0 ? args[flagI + 1] : undefined;
if (!cli) cli = existsSync(localParser) ? localParser : "geml";
const runCheck = (file) => cli.endsWith(".js")
  ? spawnSync(process.execPath, [cli, "check", file], { encoding: "utf8" })
  : spawnSync(cli, ["check", file], { encoding: "utf8", shell: process.platform === "win32" });
if (!existsSync(localParser)) {
  console.error("verify: the profile pass needs the built parser (cd geml-parser && npm install && npm run build)");
  process.exit(1);
}
const { parse } = await import(`file://${localParser.replace(/\\/g, "/")}`);

const files = [];
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".geml")) files.push(p);
  }
};
walk(rootDir);
files.sort();

// ---- pass 1: geml check ----
let failed = 0;
for (const f of files) {
  const r = runCheck(f);
  if (r.status !== 0) {
    failed++;
    console.error(`FAIL ${f}`);
    console.error((r.stderr || r.stdout || "").split("\n").slice(0, 4).map((l) => `  ${l}`).join("\n"));
  }
}

// ---- pass 2: codemap profile references ----
const REF_TABLES = new Set(["calls", "called-by", "ref-by"]);
const relDoc = (f) => relative(rootDir, f).replace(/\\/g, "/");
const docs = new Map(); // relPath -> { ids:Set, blocks }
const collectIds = (blocks, ids) => {
  for (const b of blocks) {
    if (b.id) ids.add(b.id);
    if (b.children) collectIds(b.children, ids);
    if (b.items) for (const it of b.items) if (it.children) collectIds(it.children, ids);
  }
};
for (const f of files) {
  const doc = parse(readFileSync(f, "utf8"));
  const ids = new Set();
  collectIds(doc.children, ids);
  docs.set(relDoc(f), { ids, blocks: doc.children });
}

let refErrors = 0;
const err = (doc, where, msg) => {
  refErrors++;
  console.error(`REF  ${doc} ${where}: ${msg}`);
};
const checkRef = (fromDoc, where, ref) => {
  ref = String(ref).trim();
  if (!ref) return err(fromDoc, where, "empty reference cell");
  const h = ref.indexOf("#");
  if (h < 0) return err(fromDoc, where, `not a reference: \`${ref}\``);
  let targetDoc = fromDoc;
  if (h > 0) targetDoc = posix.normalize(posix.join(posix.dirname(fromDoc), ref.slice(0, h)));
  const id = ref.slice(h + 1);
  const target = docs.get(targetDoc);
  if (!target) return err(fromDoc, where, `cannot resolve document \`${ref.slice(0, h)}\``);
  // reads/writes values may carry a plain-text `.member` suffix (ids never contain '.')
  const bare = id.split(".")[0];
  if (!target.ids.has(bare)) return err(fromDoc, where, `unresolved reference \`${ref}\``);
};

for (const [docPath, { blocks }] of docs) {
  for (const b of blocks) {
    if (b.kind !== "block") continue;
    if (b.type === "table" && REF_TABLES.has(b.id) && b.table) {
      const fromCol = b.table.columns.indexOf("from");
      const toCol = b.table.columns.indexOf("to");
      if (fromCol < 0 || toCol < 0) { err(docPath, `#${b.id}`, "missing from/to columns"); continue; }
      b.table.rows.forEach((row, i) => {
        checkRef(docPath, `#${b.id} row ${i + 1} from`, row[fromCol]?.text ?? "");
        checkRef(docPath, `#${b.id} row ${i + 1} to`, row[toCol]?.text ?? "");
      });
    }
    if (b.type === "meta" && b.data?.entry) {
      for (const ref of String(b.data.entry).split(/\s+/).filter(Boolean)) {
        checkRef(docPath, "meta entry", ref);
      }
    }
  }
}

console.error(
  `verify: ${files.length - failed}/${files.length} documents pass geml check; `
  + `profile references: ${refErrors === 0 ? "all resolve" : `${refErrors} dangling`}`,
);
process.exit(failed || refErrors ? 1 : 0);
