#!/usr/bin/env node
// What it costs to change one part of a document — measured, not modelled.
//
// Run from the repository root:
//   node docs/benchmarks/addressing-cost.mjs
//   node docs/benchmarks/addressing-cost.mjs --json > result.json
//
// Every number this prints comes from a command that actually ran against the
// documents in this repository. The write-up is docs/benchmarks/addressing-cost.md.
//
// ---------------------------------------------------------------------------
// THE DESIGN, fixed before the first run
// ---------------------------------------------------------------------------
//
// Corpus   Four documents that exist here in BOTH formats — the specification
//          and the history specification, English and Chinese, 16.8 KB to
//          70.6 KB. Same content, same heading count. Arm A edits the Markdown,
//          arm B edits the GEML, so neither arm gets the easier document.
//
// Tasks    Sampled mechanically: every Nth addressable block, about twelve per
//          document, nothing hand-picked. The document-level H1 is the only
//          exclusion — its "block" is the entire file, and no one edits a
//          document as a single operation.
//
// The job  "Replace the content of block B." The editor knows WHAT to change,
//          not WHERE it is, so both arms must find it first. The search phrase
//          comes from one rule — B's first line of twelve characters or more —
//          and both arms search for the same phrase.
//
// Arm A    grep -n <phrase>                  locate
// Markdown sed -n '<hit>,+45p'               read a 46-line window
//          (a second read when the block does not fit that window)
//          emits: a unique old_string, then the new content
//
// Arm B    geml find <phrase> <file>         locate, and get back an address
// GEML     geml get <file> <address>         read exactly that block
//          emits: the address, then the new content
//
// Counted  input   bytes of command output that enter the editor's context
//          output  bytes the editor must write
//          calls   round trips
//          The new content is identical in both arms, so it is left out of the
//          output figure: what remains is what each format charges for saying
//          WHERE a change goes.
//
// Two choices deliberately favour arm A, so the result is a floor and not a
// flattering case:
//   - the window is 46 lines, the median window an agent was measured using on
//     real work, rather than a large safe one;
//   - old_string is the SHORTEST leading slice of the block that is unique in
//     the file, which is the cheapest Edit that still applies.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const CLI = "geml-parser/dist/cli.js";
const WINDOW = 45;                     // sed -n 'hit,+45p' -> 46 lines
const TASKS_PER_DOC = 12;
const PAIRS = [
  ["spec/GEML-spec_CN.md", "spec/in_geml_format/GEML-spec_CN.geml"],
  ["spec/GEML-spec.md", "spec/in_geml_format/GEML-spec.geml"],
  // The history documents left this corpus when GEML-history-spec became the
  // geml-history/v1 profile: a profile document carries no `.geml` rendering
  // (neither geml-style nor geml-codemap has one), so there is no .md/.geml
  // pair left to measure. The recorded results below still show the four-pair
  // run that produced them.
];

const sh = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20 }); }
  catch (e) { return (e.stdout ?? "") + (e.stderr ?? ""); }
};
const geml = (...args) => sh(process.execPath, [CLI, ...args]);

function blocksOf(gemlPath) {
  let rows;
  try { rows = JSON.parse(geml("list", gemlPath, "--json")); } catch { return []; }
  return rows
    .map((r) => ({ address: r.address ?? r.id ?? "", kind: r.kind ?? "", level: r.level ?? 0 }))
    .filter((r) => r.address);
}

// The phrase a person would search for: the block's first line of substance.
function phraseFor(text) {
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (l.length >= 12 && !/^===/.test(l) && !/^#{1,6}\s/.test(l)) return l.slice(0, 40);
  }
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.replace(/^#{1,6}\s*/, "").replace(/\{#.*\}\s*$/, "").trim();
    if (l.length >= 6) return l.slice(0, 40);
  }
  return null;
}

// Arm A's old_string: the fewest leading lines of the block that occur exactly
// once in the file — the cheapest exact-string edit that is still correct.
function uniquePrefix(mdText, blockText) {
  const lines = blockText.split(/\r?\n/).filter((l) => l.trim());
  let probe = "";
  for (const l of lines) {
    probe = probe ? probe + "\n" + l : l;
    let at = -1, n = 0;
    while ((at = mdText.indexOf(probe, at + 1)) >= 0) { if (++n > 1) break; }
    if (n === 1) return probe;
  }
  return blockText;
}

const rows = [];
const skipped = { noPhrase: 0, notInMarkdown: 0, documentH1: 0, unreadable: 0 };

for (const [mdPath, gemlPath] of PAIRS) {
  const md = readFileSync(mdPath, "utf8");
  const mdLines = md.split(/\r?\n/);
  const all = blocksOf(gemlPath);
  const candidates = all.filter((b) => !(b.kind === "heading" && b.level === 1));
  skipped.documentH1 += all.length - candidates.length;
  const step = Math.max(1, Math.floor(candidates.length / TASKS_PER_DOC));
  const picked = candidates.filter((_, i) => i % step === 0).slice(0, TASKS_PER_DOC);

  for (const b of picked) {
    const block = geml("get", gemlPath, b.address);
    if (!block.trim() || /^error:/.test(block)) { skipped.unreadable++; continue; }
    const phrase = phraseFor(block);
    if (!phrase) { skipped.noPhrase++; continue; }
    // The same phrase must exist in the Markdown twin, or the two arms would
    // not be doing the same job.
    const hit = mdLines.findIndex((l) => l.includes(phrase));
    if (hit < 0) { skipped.notInMarkdown++; continue; }

    // --- arm A.  `--` guards a phrase that begins with `-`; without it grep
    // reads the phrase as a flag and arm A gets charged less than it costs.
    const grepOut = sh("grep", ["-n", "-F", "--", phrase, mdPath]);
    const windowOut = mdLines.slice(hit, hit + WINDOW + 1).join("\n");
    const blockLines = block.split(/\r?\n/).length;
    const secondRead = blockLines > WINDOW + 1 ? mdLines.slice(hit, hit + blockLines).join("\n") : "";

    // --- arm B
    const findOut = geml("find", phrase, gemlPath);

    rows.push({
      doc: mdPath.split("/").pop(),
      address: b.address,
      kind: b.kind,
      aIn: grepOut.length + windowOut.length + secondRead.length,
      aCalls: 2 + (secondRead ? 1 : 0),
      aOut: uniquePrefix(md, block).length,
      bIn: findOut.length + block.length,
      bCalls: 2,
      bOut: b.address.length,
      blockBytes: block.length,
      windowMissed: secondRead ? 1 : 0,
    });
  }
}

const sum = (f) => rows.reduce((a, r) => a + f(r), 0);
const pct = (f, p) => { const s = rows.map(f).sort((a, b) => a - b); return s[Math.floor(s.length * p)]; };
const ratios = rows.map((r) => r.aIn / Math.max(r.bIn, 1)).sort((a, b) => a - b);
const at = (p) => ratios[Math.floor(ratios.length * p)];

const byDoc = {};
for (const r of rows) (byDoc[r.doc] ??= []).push(r);

const result = {
  tasks: rows.length,
  skipped,
  input: { markdown: sum((r) => r.aIn), geml: sum((r) => r.bIn) },
  outputToSayWhere: { markdown: sum((r) => r.aOut), geml: sum((r) => r.bOut) },
  roundTrips: { markdown: sum((r) => r.aCalls), geml: sum((r) => r.bCalls) },
  medianInputPerTask: { markdown: pct((r) => r.aIn, 0.5), geml: pct((r) => r.bIn, 0.5) },
  perTaskInputRatio: { min: at(0), p25: at(0.25), median: at(0.5), p75: at(0.75), max: ratios[ratios.length - 1] },
  gemlCostsMoreOn: rows.filter((r) => r.bIn > r.aIn).length,
  windowMissedTheBlock: sum((r) => r.windowMissed),
  perDocument: Object.fromEntries(Object.entries(byDoc).map(([doc, rs]) => [doc, {
    tasks: rs.length,
    input: rs.reduce((a, r) => a + r.aIn, 0) / rs.reduce((a, r) => a + r.bIn, 0),
    outputToSayWhere: rs.reduce((a, r) => a + r.aOut, 0) / rs.reduce((a, r) => a + r.bOut, 0),
  }])),
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ ...result, rows }, null, 1));
  process.exit(0);
}

const r2 = (a, b) => (a / Math.max(b, 1)).toFixed(2) + "x";
console.log(`${result.tasks} edits across ${PAIRS.length} documents, each present as both Markdown and GEML`);
console.log(`skipped: ${JSON.stringify(skipped)}`);
console.log("");
console.log("                          Markdown          GEML     ratio");
const line = (l, a, b) => console.log(`${l.padEnd(22)} ${String(a).padStart(11)} ${String(b).padStart(13)}    ${r2(a, b)}`);
line("input bytes", result.input.markdown, result.input.geml);
line("output: to say where", result.outputToSayWhere.markdown, result.outputToSayWhere.geml);
line("round trips", result.roundTrips.markdown, result.roundTrips.geml);
line("median input / edit", result.medianInputPerTask.markdown, result.medianInputPerTask.geml);
console.log("");
console.log(`GEML costs more input on ${result.gemlCostsMoreOn} of ${result.tasks} edits`);
console.log(`the 46-line window did not contain the block on ${result.windowMissedTheBlock} of ${result.tasks}`);
console.log(`per-edit input ratio: min ${at(0).toFixed(2)}x · median ${at(0.5).toFixed(2)}x · max ${ratios[ratios.length - 1].toFixed(2)}x`);
console.log("");
for (const [doc, d] of Object.entries(result.perDocument)) {
  console.log(`  ${doc.padEnd(28)} n=${String(d.tasks).padStart(2)}   input ${d.input.toFixed(2)}x   where ${d.outputToSayWhere.toFixed(1)}x`);
}
