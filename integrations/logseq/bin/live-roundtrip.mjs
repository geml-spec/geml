// The live half of the spike: run the round trip against a REAL DB graph via
// the official @logseq/cli, with Logseq's own `validate` as the judge.
//
//   node bin/live-roundtrip.mjs <graph-name> [--edit]
//
// Stages (each printed, each gated):
//   1. `logseq export-edn -g <graph>`            → out/export-1.edn
//   2. ednToGemlFiles                            → out/geml/**.geml
//   3. `geml check --root out/geml` on every doc (zero errors required)
//   4. gemlFilesToEdn                            → out/import.edn
//   5. STRUCTURAL identity export-1 ⇄ import.edn (EDN semantics) — the offline
//      criterion, now on real data
//   6. with --edit: `geml set` the first uuid block, rebuild import.edn, and
//      `logseq import-edn` it back, then `logseq validate` — the semantics
//      probe: does re-import by uuid update in place, or append?
//
// Import-back is opt-in (--edit) because import semantics on a whole-graph
// re-import are exactly what this stage exists to LEARN — it may merge, it may
// duplicate id-less blocks. The script never touches a graph unless told to.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEDNString } from "edn-data";
import { ednToGemlFiles, gemlFilesToEdn } from "../src/mapping.mjs";
import { parse, addressedUnits, sliceUnit } from "../../../geml-parser/dist/geml.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "out");
const GEML = resolve(here, "..", "..", "..", "geml-parser", "dist", "geml.js");
const lib = { parse, addressedUnits, sliceUnit };

const [graph, ...flags] = process.argv.slice(2);
if (!graph) { console.error("usage: node bin/live-roundtrip.mjs <graph-name> [--edit]"); process.exit(2); }
const doEdit = flags.includes("--edit");

// The CLI is driven through npx so nothing here depends on a global install;
// LOGSEQ_CLI_DIR points at a directory whose node_modules has @logseq/cli.
const cliCwd = process.env.LOGSEQ_CLI_DIR ?? join(here, "..");
const logseq = (...args) =>
  execFileSync("npx", ["-y", "@logseq/cli", ...args], { cwd: cliCwd, encoding: "utf8", shell: true, maxBuffer: 1 << 28 });
const geml = (...args) =>
  execFileSync(process.execPath, [GEML, ...args], { encoding: "utf8", maxBuffer: 1 << 28 });

// EDN-semantics canonical form (same as the test suite).
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v !== null && typeof v === "object") {
    if (Array.isArray(v.map)) {
      const entries = v.map.map(([k, val]) => [canon(k), canon(val)]);
      entries.sort((a, b) => (JSON.stringify(a[0]) < JSON.stringify(b[0]) ? -1 : 1));
      return { map: entries };
    }
    if (Array.isArray(v.set)) {
      const items = v.set.map(canon);
      items.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
      return { set: items };
    }
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canon(v[k]);
    return o;
  }
  return v;
}
const same = (a, b) => JSON.stringify(canon(parseEDNString(a))) === JSON.stringify(canon(parseEDNString(b)));

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "geml"), { recursive: true });

console.log(`1. export-edn from graph "${graph}"`);
logseq("export-edn", "-g", graph, "-f", join(out, "export-1.edn"));
const edn1 = readFileSync(join(out, "export-1.edn"), "utf8");
console.log(`   ${edn1.length} bytes of EDN`);

console.log("2. EDN -> GEML");
const files = ednToGemlFiles(edn1);
for (const [rel, text] of files) {
  mkdirSync(dirname(join(out, "geml", rel)), { recursive: true });
  writeFileSync(join(out, "geml", rel), text);
}
console.log(`   ${files.size} documents`);

console.log("3. geml check on every document");
let dirty = 0;
for (const rel of files.keys()) {
  try { geml("check", "--root", join(out, "geml"), join(out, "geml", rel)); }
  catch (e) { dirty++; console.error(`   FAIL ${rel}\n${e.stdout ?? ""}${e.stderr ?? ""}`); }
}
if (dirty) { console.error(`   ${dirty} document(s) not clean — stopping`); process.exit(1); }
console.log("   all clean");

console.log("4. GEML -> EDN");
const files2 = new Map();
for (const rel of files.keys()) files2.set(rel, readFileSync(join(out, "geml", rel), "utf8"));
const edn2 = gemlFilesToEdn(files2, lib);
writeFileSync(join(out, "import.edn"), edn2);

console.log("5. structural identity, on the real graph");
if (!same(edn1, edn2)) { console.error("   NOT identical — diff out/export-1.edn against out/import.edn"); process.exit(1); }
console.log("   identical (EDN semantics)");

if (!doEdit) { console.log("\nround trip holds. Re-run with --edit to probe import-back semantics."); process.exit(0); }

console.log("6. edit one uuid block via `geml set`, import back, validate");
const withUuid = [...files.keys()].map((rel) => {
  const text = files2.get(rel);
  const unit = [...addressedUnits(text)].map((a) => a.unit).find((u) => u.kind === "block" && u.id && /^[0-9a-f-]{36}$/.test(u.id));
  return unit ? { rel, unit } : null;
}).find(Boolean);
if (!withUuid) { console.log("   no uuid-bearing block in this graph (nothing referenced) — skipping the edit probe"); process.exit(0); }

const target = join(out, "geml", withUuid.rel);
// Keep the block's own head line (type, id, level) — the edit is to the BODY.
const src = files2.get(withUuid.rel);
const head = sliceUnit(src, withUuid.unit.span, "head").trimEnd();
const body = sliceUnit(src, withUuid.unit.span, "body").trimEnd();
const fence = head.match(/^=+/)[0];
writeFileSync(join(out, "edit.txt"), `${head}\n${body} — edited by geml\n${fence}\n`);
geml("set", target, `#${withUuid.unit.id}`, "--in", join(out, "edit.txt"), "--root", join(out, "geml"));
console.log(`   edited #${withUuid.unit.id} in ${withUuid.rel}`);

const files3 = new Map();
for (const rel of files.keys()) files3.set(rel, readFileSync(join(out, "geml", rel), "utf8"));
writeFileSync(join(out, "import-edited.edn"), gemlFilesToEdn(files3, lib));
logseq("import-edn", "-g", graph, "-f", join(out, "import-edited.edn"));
console.log("   imported");
console.log(logseq("validate", "-g", graph).trim());

console.log("7. export again — inspect out/export-2.edn to judge merge semantics");
logseq("export-edn", "-g", graph, "-f", join(out, "export-2.edn"));
console.log("done — compare out/export-1.edn / out/export-2.edn");
