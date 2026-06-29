// Round-trip property: serialize(parse(src)) parses back to the same model.
//
//     parse(serialize(parse(src)))  ≅  parse(src)
//
// This is the testable core of "round-trip editing": the document model is a
// faithful, lossless representation of the source — you can regenerate source
// from the model and re-parsing yields the same model. The serializer normalizes
// surface syntax (whitespace, quoting, fence length, footnote shorthand), so the
// comparison is on the *model*, not the bytes: block tree, id set, and the
// number of diagnostics of each severity (no corruption introduced).
//
// Corpus = every `geml` input in the conformance suite (inline, precedence,
// lists) + hand-written block-level documents + the real GEML spec.
import { parse, serialize } from "../dist/geml.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));

// --- corpus -----------------------------------------------------------------

const conformance = [];
for (const file of ["inline.json", "precedence.json", "lists.json"]) {
  const cases = JSON.parse(readFileSync(join(here, "conformance", file), "utf8"));
  for (const c of cases) conformance.push({ name: `${file}:${c.name}`, src: c.geml });
}

// Block-level documents the JSON fixtures don't cover: typed blocks, headings
// with attributes, meta/data, nested fences, tables, charts, hidden lines,
// footnote definitions, and mixed multi-block documents.
const blockDocs = [
  ["heading + para", "# Title {#title}\n\nA paragraph with *em* and `code`."],
  ["heading levels", "# H1\n\n## H2 {#h2}\n\n### H3 with **bold**"],
  ["heading with class+attr", "## Notes {#notes .sidebar lang=en}\n\nbody"],
  ["code block", "=== code {lang=python}\nprint('hi')\nx = 1\n==="],
  ["note flow block", "=== note {#tip}\nSee [[#title]] for context.\n\nSecond paragraph.\n==="],
  ["meta data block", "=== meta\ntitle = Quarterly Report\nyear = 2025\ndraft = true\n==="],
  ["aside with emphasis", "=== aside\nThis is *important* and ~~struck~~.\n==="],
  ["nested fences", "==== note {#outer}\nIntro.\n\n=== code {lang=js}\nconst a = 1;\n===\n\nOutro.\n===="],
  ["deeper nested fences", "===== aside\nA.\n\n==== note\nB.\n\n=== code\nc\n===\n====\n====="],
  ["unknown block type", "=== sidebar {#sb}\narbitrary raw body\nmore\n==="],
  ["hidden line", "Visible paragraph.\n\n%% a hidden scratch note\n\nMore visible text."],
  ["footnote definition", "A claim.[^src]\n\n[^src]: The supporting source."],
  ["table block", "=== table {#fy25}\n| Q | Rev |\n|---|-----|\n| Q1 | 10 |\n| Q2 | 20 |\n==="],
  ["chart bound to table", "=== table {#data}\n| x | y |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n===\n\n=== diagram {format=geml-chart data=#data x=x y=y kind=line}\n==="],
  ["output of code", "=== code {#snippet lang=js}\n1 + 1\n===\n\n=== output {of=#snippet}\n2\n==="],
  ["math block", "=== math\nE = mc^2\n==="],
  ["fenced body with equals run", "=== code\na\n====\nb\n==="],
  ["task + nested list", "- [ ] top\n  - [x] sub one\n  - [ ] sub two\n- [x] done"],
  ["ordered start", "3. three\n4. four\n5. five"],
  ["loose list", "- first item\n\n- second item\n\n- third item"],
  ["links and refs", "See [the spec](GEML-spec.geml#intro), [[#title]], and [home](https://example.com)."],
  ["image", "![a diagram](chart.png){as=image width=400}"],
  ["mixed document", "# Report {#report}\n\nIntro paragraph with a [link](#sec).\n\n## Section {#sec}\n\n- one\n- two\n\n=== code {lang=sh}\necho hi\n===\n\nClosing words."],
  ["escaped punctuation", "Literal \\*stars\\* and \\`ticks\\` and a \\[bracket and \\$dollar."],
  ["math and code inline", "Inline $x^2$ then `f(x)` then *em*."],
];

// The real spec document, as a large end-to-end case.
const specDocs = [];
for (const rel of ["../../GEML-spec.geml"]) {
  try {
    specDocs.push(["GEML-spec.geml", readFileSync(join(here, rel), "utf8")]);
  } catch { /* spec not present in this checkout — skip */ }
}

const corpus = [
  ...conformance,
  ...blockDocs.map(([name, src]) => ({ name, src })),
  ...specDocs.map(([name, src]) => ({ name, src })),
];

// --- the property -----------------------------------------------------------

const sevCounts = (diags) => {
  const c = { error: 0, warning: 0 };
  for (const d of diags) c[d.severity]++;
  return c;
};

// Compare the *semantic* model, not the bytes. Flow blocks (headings,
// paragraphs, list items) carry a raw-source `text` mirror beside their parsed
// `inlines`; the serializer normalizes surface syntax, so that raw slice
// legitimately changes while `inlines` — the actual model — is preserved. Drop
// the mirror (a node has one exactly when it also has `inlines`) before diffing.
function semantic(node) {
  if (Array.isArray(node)) return node.map(semantic);
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "text" && "inlines" in node) continue;
      out[k] = semantic(v);
    }
    return out;
  }
  return node;
}

let pass = 0;
let fail = 0;
for (const { name, src } of corpus) {
  const a = parse(src);
  const round = serialize(a);
  const b = parse(round);
  try {
    assert.deepEqual(semantic(b.children), semantic(a.children), "block model differs after round-trip");
    assert.deepEqual(b.ids, a.ids, "id set differs after round-trip");
    assert.deepEqual(sevCounts(b.diagnostics), sevCounts(a.diagnostics), "diagnostic counts differ");
    pass++;
  } catch (err) {
    fail++;
    console.error(`FAIL [${name}]`);
    console.error(`  src:    ${JSON.stringify(src.length > 120 ? src.slice(0, 120) + "…" : src)}`);
    console.error(`  serial: ${JSON.stringify(round.length > 200 ? round.slice(0, 200) + "…" : round)}`);
    console.error(`  ${err.message}`);
  }
}

console.log(`\nround-trip: ${pass} case(s) passed${fail ? `, ${fail} FAILED` : ""}.`);
if (fail) process.exit(1);
