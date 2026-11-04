// The reader against a real body of Godot projects — the acceptance run.
//
//   node engines/godot/test/corpus.mjs <dir>
//
// Every `.tscn`, `.tres`, `project.godot`, `.import` and `.cfg` under <dir> is
// read; each must read whole. Then every number in every file is rewritten
// through its extent — the splice geml makes for a coordinate edit — and the
// file must read back with that value, and only that value, changed. Last, the
// reader's own checks run, and every diagnostic is printed: on projects that
// open in Godot, each one is a false alarm to fix here.
//
// Not part of `npm test`: the corpus is not in this repository. The official
// demos are the one it was accepted against —
//   git clone --depth 1 --filter=blob:none --sparse https://github.com/godotengine/godot-demo-projects
//   git sparse-checkout set --no-cone '*.tscn' '*.tres' '*.godot' '*.import' '*.cfg'
// — with an empty file put at every other tracked path, so `res://` checks see
// the assets a sparse checkout leaves out.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname, basename } from "node:path";
import reader from "../reader.mjs";

const dir = process.argv[2];
if (!dir) { console.error("usage: node test/corpus.mjs <dir>"); process.exit(2); }

const byExt = new Map(reader.readers.flatMap((r) => r.extensions.map((e) => [e, r])));
const files = [];
(function walk(d) {
  for (const name of readdirSync(d)) {
    if (name === ".git" || name === ".godot") continue;
    const p = join(d, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (byExt.has(extname(name).toLowerCase())) files.push(p);
  }
})(dir);

const stepsText = (at) => at.map((s) => (typeof s === "number" ? `[${s}]` : `[${JSON.stringify(s)}]`)).join("");
const failures = [];
const diagnostics = [];
let read = 0, writes = 0, extents = 0;
const count = new Map();

for (const file of files) {
  const r = byExt.get(extname(file).toLowerCase());
  count.set(r.format, (count.get(r.format) ?? 0) + 1);
  const text = readFileSync(file, "utf8");
  let res;
  try { res = r.read(text, { path: file }); }
  catch (e) { failures.push(`${file}: does not read: ${e.message}`); continue; }
  read++;
  extents += res.extents.length;
  for (const d of res.diagnostics ?? []) diagnostics.push(`${file}: ${r.format}/${d.code} ${stepsText(d.at)}: ${d.message}`);
  // Every number, rewritten through its extent: only that value may change.
  for (const x of res.extents) {
    const was = text.slice(x.start, x.end);
    if (!/^-?\d+(\.\d+)?$/.test(was)) continue;
    const next = was === "7" ? "8" : "7";
    const after = text.slice(0, x.start) + next + text.slice(x.end);
    let back;
    try { back = r.read(after, { path: file }); }
    catch (e) { failures.push(`${file} ${stepsText(x.at)}: no longer reads after a write: ${e.message}`); continue; }
    const hit = back.extents.find((y) => stepsText(y.at) === stepsText(x.at));
    if (!hit || hit.start !== x.start || hit.end !== x.start + next.length) {
      failures.push(`${file} ${stepsText(x.at)}: does not read back as the value written`);
      continue;
    }
    writes++;
  }
}

const projects = files.filter((f) => basename(f) === "project.godot").length;
console.log(`files ${files.length} (${[...count].map(([k, v]) => `${k} ${v}`).join(", ")}), projects ${projects}`);
console.log(`read whole ${read}/${files.length}, extents ${extents}, number writes read back ${writes}`);
console.log(`failures ${failures.length}, diagnostics ${diagnostics.length}`);
for (const f of failures.slice(0, 40)) console.log(`FAIL ${f}`);
for (const d of diagnostics.slice(0, 40)) console.log(`DIAG ${d}`);
process.exit(failures.length + diagnostics.length === 0 ? 0 : 1);
