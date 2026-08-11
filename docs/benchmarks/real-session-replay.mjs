#!/usr/bin/env node
// What a day of real document editing would have cost with GEML in the mix.
//
// Run from the repository root:
//   node docs/benchmarks/real-session-replay.mjs
//   node docs/benchmarks/real-session-replay.mjs --json
//
// The write-up is docs/benchmarks/mixed-toolchain_CN.md (English: mixed-toolchain.md).
//
// ---------------------------------------------------------------------------
// WHERE THE TWO SIDES COME FROM
// ---------------------------------------------------------------------------
//
// The baseline is not a model. `real-session-edits.json` holds what one agent
// actually did while editing README_CN.md for a day, recovered from its session
// log: for every edit, the bytes it read to locate the place, how many calls
// that took, and the bytes of old text it had to quote to say where the change
// goes. The log stays private; that file is everything derived from it.
//
// The GEML side runs live, here, now. This script converts README_CN.md into
// GEML, then for each recovered edit searches for the text that edit landed and
// reads the block it lands in — `geml find` followed by `geml get`, both really
// executed, both charged in full.
//
// ---------------------------------------------------------------------------
// THE RULE FOR WHICH TOOL DOES WHICH EDIT — fixed before running
// ---------------------------------------------------------------------------
//
// Nothing here picks whichever tool turned out cheaper. The split is the
// agent's OWN choice, recorded at the time, and each side goes to the GEML verb
// built for that shape of work:
//
//   - Edits it made one at a time, after reading the text, go to `find` + `get`:
//     locate by content, read exactly the block.
//   - Edits it made as a batched replacement — several string swaps in one
//     script, because it already knew the exact old text — go to `replace`,
//     which needs no read at all.
//
// THE SECOND ROUTE IS NEW, and the reason this run differs from earlier ones.
// The rule used to leave batched edits on the original commands, because GEML
// had no verb for "the old text is already known"; `geml replace` is that verb,
// so the exception it was written for is gone.
//
// It also exposes something the old rule hid. "Blind replacement reads nothing"
// is not what the recorded day actually shows: of the nineteen batched edits,
// exactly one read nothing. The rest read a window first — the same window
// several times over, amortised across the swaps in one script — which is
// precisely the cost `replace` removes.
//
// An edit whose landed text is no longer in the document is dropped — it was
// superseded later in the same session, so NEITHER side could locate it.
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = "geml-parser/dist/cli.js";
const MD = "README_CN.md";
const DATASET = "docs/benchmarks/real-session-edits.json";

const geml = (...a) => {
  try { return execFileSync(process.execPath, [CLI, ...a], { encoding: "utf8", maxBuffer: 64 << 20 }); }
  catch (e) { return (e.stdout ?? "") + (e.stderr ?? ""); }
};
// `replace` reports on stderr and puts the document on stdout, so the cost a
// caller reads back is the stderr half alone.
const gemlErr = (...a) => {
  const r = spawnSync(process.execPath, [CLI, ...a], { encoding: "utf8", maxBuffer: 64 << 20 });
  return r.stderr ?? "";
};

// --- build the GEML twin, and pay the conversion cost in the open.
// Markdown names its sections with raw <a id="x"></a> tags because it has no
// other way; in GEML the heading carries the id, so fold each anchor into the
// heading that follows it. That folding is the one-time cost of moving a
// document over, and the report says so.
const work = mkdtempSync(join(tmpdir(), "geml-replay-"));
const twin = join(work, "README_CN.geml");
geml(MD, "--from", "md", "--to", "geml", "-o", twin);

const raw = readFileSync(twin, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
const out = [];
let anchor = null, folded = 0;
for (const line of raw.split(/\r?\n/)) {
  const a = /^\s*<a id="([a-z0-9-]+)"><\/a>\s*$/.exec(line);
  if (a) { anchor = a[1]; continue; }
  const h = /^(#{1,6})\s+(.*)$/.exec(line);
  if (h && anchor && !/\{#/.test(line)) {
    out.push(`${h[1]} ${h[2].trimEnd()} {#${anchor}}`);
    anchor = null; folded++;
    continue;
  }
  if (line.trim() !== "" && anchor) anchor = null;
  out.push(line);
}
writeFileSync(twin, out.join(eol));

// --- replay
const md = readFileSync(MD, "utf8");
const data = JSON.parse(readFileSync(DATASET, "utf8"));

const phraseOf = (text) => {
  const best = String(text).split(/\r?\n/).map((x) => x.trim())
    .filter((x) => x.length > 12).sort((a, b) => b.length - a.length)[0];
  return best ? best.slice(0, 36) : null;
};

const rows = [];
const dropped = { noPhrase: 0, superseded: 0, unaddressable: 0 };
for (const e of data.edits) {
  const phrase = phraseOf(e.landed);
  if (!phrase) { dropped.noPhrase++; continue; }
  if (!md.includes(phrase.slice(0, 24))) { dropped.superseded++; continue; }
  const found = geml("find", phrase, twin);
  const hit = found.split(/\r?\n/).find((l) => l.includes("\t"));
  if (!hit) { dropped.superseded++; continue; }
  const address = hit.split("\t")[1];
  const block = geml("get", twin, address);
  if (!block.trim() || /^error:/.test(block)) { dropped.unaddressable++; continue; }
  const batched = e.tool.startsWith("script");
  // A batched edit goes through `replace`, which reads nothing: its whole input
  // cost is the one-line report that comes back. Measured by running it for
  // real — an identity swap of the phrase, written to stdout so the twin is not
  // disturbed — because the report is what the caller actually pays for.
  const report = batched ? gemlErr("replace", twin, phrase, phrase, "-o", "-") : "";
  rows.push({
    tool: e.tool,
    batched,
    address,
    markdownIn: e.measured.inputBytes,
    markdownWhere: e.measured.sayWhereBytes,
    markdownCalls: e.measured.locateCalls,
    // `replace` says where with the old text, exactly as the script did — the
    // same bytes, so that column is unchanged and only the reading differs.
    gemlIn: batched ? report.length : found.length + block.length,
    gemlWhere: batched ? e.measured.sayWhereBytes : address.length,
    gemlCalls: batched ? 1 : 2,
  });
}

const T = (rs, f) => rs.reduce((a, r) => a + f(r), 0);
const batch = rows.filter((r) => r.batched);
const addressed = rows.filter((r) => !r.batched);

// all-Markdown: what actually happened
const allIn = T(rows, (r) => r.markdownIn), allWhere = T(rows, (r) => r.markdownWhere);
// GEML throughout, each edit on the verb built for it: `replace` for the
// batched ones, `find` + `get` for the rest. Nothing is handed off any more.
const mixIn = T(rows, (r) => r.gemlIn);
const mixWhere = T(rows, (r) => r.gemlWhere);
// For reference: what the batched edits would cost if they still had to leave
// GEML, which is what this benchmark measured before `replace` existed.
const handoffIn = T(batch, (r) => r.markdownIn) + T(addressed, (r) => r.gemlIn);
const allGemlIn = mixIn, allGemlWhere = mixWhere;

const result = {
  recovered: data.edits.length,
  replayed: rows.length,
  dropped,
  anchorsFolded: folded,
  allMarkdown: { input: allIn, sayWhere: allWhere },
  mixed: { input: mixIn, sayWhere: mixWhere },
  allGeml: { input: allGemlIn, sayWhere: allGemlWhere },
  ratios: {
    mixedInput: allIn / Math.max(mixIn, 1),
    mixedSayWhere: allWhere / Math.max(mixWhere, 1),
    allGemlInput: allIn / Math.max(allGemlIn, 1),
  },
  addressedEdits: {
    count: addressed.length,
    shareOfMarkdownInput: T(addressed, (r) => r.markdownIn) / Math.max(allIn, 1),
    input: { markdown: T(addressed, (r) => r.markdownIn), geml: T(addressed, (r) => r.gemlIn) },
    sayWhere: { markdown: T(addressed, (r) => r.markdownWhere), geml: T(addressed, (r) => r.gemlWhere) },
  },
  batchedEdits: {
    count: batch.length,
    input: { markdown: T(batch, (r) => r.markdownIn), geml: T(batch, (r) => r.gemlIn) },
    note: "routed through geml replace, which reads nothing — only the report is charged",
  },
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ ...result, rows }, null, 1));
  process.exit(0);
}

const x = (a, b) => (a / Math.max(b, 1)).toFixed(2) + "x";
console.log(`${data.edits.length} edits recovered from the session log, ${rows.length} replayable`);
console.log(`dropped: ${JSON.stringify(dropped)}   (superseded = the text was itself rewritten later that day)`);
console.log(`conversion cost paid up front: ${folded} raw <a id> anchors folded into heading ids`);
console.log("");
console.log("                        all Markdown         GEML      ratio");
console.log(`input bytes         ${String(allIn).padStart(16)} ${String(mixIn).padStart(12)}    ${x(allIn, mixIn)}`);
console.log(`output: to say where${String(allWhere).padStart(16)} ${String(mixWhere).padStart(12)}    ${x(allWhere, mixWhere)}`);
console.log("");
console.log("where it comes from:");
console.log(`  batched replacement   n=${String(batch.length).padStart(2)}  ${T(batch, (r) => r.markdownIn)} -> ${T(batch, (r) => r.gemlIn)} bytes   ·   geml replace reads nothing; the report is the whole cost`);
console.log(`  needs an address      n=${String(addressed.length).padStart(2)}  ${T(addressed, (r) => r.markdownIn)} -> ${T(addressed, (r) => r.gemlIn)} bytes   ·   saying where ${T(addressed, (r) => r.markdownWhere)} -> ${T(addressed, (r) => r.gemlWhere)}`);
console.log("");
console.log(`  those ${addressed.length} edits are ${(100 * result.addressedEdits.shareOfMarkdownInput).toFixed(0)}% of everything the all-Markdown day read, on ${addressed.length}/${rows.length} of the edits`);
console.log("");
console.log(`before \`replace\` existed the batched edits had to leave GEML, which came to ${x(allIn, handoffIn)} — the gap between that and ${x(allIn, mixIn)} is what one verb was worth`);
