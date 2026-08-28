// M3 conformance checks: tables (§6) and diagram renderer registry (§7).
// Run with `npm test` (after `npm run build`).
import { parse } from "../dist/geml.js";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const table = (src) => parse(src).children[0].table;
const errors = (d) => d.diagnostics.filter((x) => x.severity === "error");

test("visual form: header, alignment, numeric cells (§6a)", () => {
  const t = table("=== table {caption=\"c\"}\n| Plan | N |\n|------|--:|\n| Org | 1 |\n| Adoc | 2 |\n===");
  assert.deepEqual(t.columns, ["Plan", "N"]);
  assert.equal(t.header, true);
  assert.equal(t.align[1], "right");
  assert.equal(t.caption, "c");
  assert.equal(t.rows.length, 2);
  assert.equal(t.rows[0][1].value, 1);
});

test("data form: csv + per-row compute (§6b)", () => {
  const t = table("=== table {format=csv compute=\"Sub = M * R\"}\nName, M, R\nOrg, 1, 30\nAdoc, 2, 30\n===");
  assert.deepEqual(t.columns, ["Name", "M", "R", "Sub"]);
  assert.equal(t.rows[0][3].text, "30");
  assert.equal(t.rows[1][3].value, 60);
  assert.equal(t.rows[1][3].computed, true);
});

test("compute by column letter and aggregate (§6)", () => {
  const t = table("=== table {format=csv compute=\"T = sum(B)\"}\nName, V\na, 10\nb, 20\n===");
  assert.equal(t.rows[0][2].value, 30);
  assert.equal(t.rows[1][2].value, 30);
});

test("compute precedence and parentheses", () => {
  const t = table("=== table {format=csv compute=\"X = (A + B) * 2\"}\nA, B\n1, 2\n===");
  assert.equal(t.rows[0][2].value, 6);
});

test("compute over unknown column is an error", () => {
  const d = parse("=== table {format=csv compute=\"X = nope * 2\"}\nA\n1\n===");
  assert.ok(errors(d).some((e) => /unknown column/.test(e.message)));
});



test("headerless visual form uses letter columns", () => {
  const t = table("=== table\n| a | b |\n| c | d |\n===");
  assert.deepEqual(t.columns, ["A", "B"]);
  assert.equal(t.header, false);
});

test("compute: ;-separated formulas, [printf] format, ref to earlier column (§6)", () => {
  const t = table("=== table {format=csv compute=\"FY [%.1f] = Q1 + Q2; Half [%.0f] = FY / 2\"}\nSeg, Q1, Q2\nA, 1.25, 2.25\n===");
  assert.deepEqual(t.columns, ["Seg", "Q1", "Q2", "FY", "Half"]);
  assert.equal(t.rows[0][3].value, 3.5);
  assert.equal(t.rows[0][3].text, "3.5");
  assert.equal(t.rows[0][4].text, "2"); // 1.75 -> %.0f
});

test("compute: quoted column name with spaces (§6)", () => {
  const t = table("=== table {format=csv compute=\"Tot = 'Unit Price' * Qty\"}\nUnit Price, Qty\n3, 4\n===");
  assert.equal(t.rows[0][2].value, 12);
});

test("compute: default rendering drops float noise (§6)", () => {
  const t = table("=== table {format=csv compute=\"S = A + B\"}\nA, B\n0.1, 0.2\n===");
  assert.equal(t.rows[0][2].text, "0.3");
});

test("format: %% renders a literal percent (§6)", () => {
  const t = table("=== table {format=csv compute=\"P [%.1f%%] = Q1\"}\nQ1\n12.34\n===");
  assert.equal(t.rows[0][1].text, "12.3%");
});

test("summary: label + aggregate + arithmetic over aggregates (§6)", () => {
  const t = table("=== table {format=csv compute=\"FY = Q1 + Q2\" summary=\"Seg = 'Total'; Q1 = sum(Q1); FY = sum(FY) - sum(Q1)\"}\nSeg, Q1, Q2\nA, 1, 2\nB, 3, 4\n===");
  assert.equal(t.summary[0].text, "Total");
  assert.equal(t.summary[1].value, 4);  // sum(Q1)=1+3
  assert.equal(t.summary[3].value, 6);  // sum(FY)=3+7 minus sum(Q1)=4 -> 6
});

test("summary: a bare (non-aggregated) column reference is an error (§6)", () => {
  const d = parse("=== table {format=csv compute=\"FY = Q1 + Q2\" summary=\"FY = FY\"}\nSeg, Q1, Q2\nA, 1, 2\n===");
  assert.ok(errors(d).some((e) => /aggregate/.test(e.message)));
});

test("delim=: a data body splits on the named character, not the format's (§6)", () => {
  // A European CSV: `;` separates, and everything downstream of the split — the
  // header row, numeric cells, compute, summary — behaves as it does for `,`.
  const t = table('=== table {format=csv delim=";" compute="FY = Q1 + Q2" summary="FY = sum(FY)"}\nSeg;Q1;Q2\nA;1;2\nB;3;4\n===');
  assert.deepEqual(t.columns, ["Seg", "Q1", "Q2", "FY"]);
  assert.deepEqual(t.rows.map((r) => r[0].text), ["A", "B"]);
  assert.equal(t.rows[0][2].value, 2);
  assert.equal(t.rows[1][3].value, 7);
  assert.equal(t.summary[3].value, 10);
});

test("delim=: overrides tsv's tab too, and no delim keeps the natural one (§6)", () => {
  const over = table('=== table {format=tsv delim=";"}\nSeg;Q1\nA;1\n===');
  assert.deepEqual(over.columns, ["Seg", "Q1"]);
  const natural = table("=== table {format=tsv}\nSeg\tQ1\nA\t1\n===");
  assert.deepEqual(natural.columns, ["Seg", "Q1"]);
});

test('delim="|" splits on pipes without the visual form\'s stripping (§6)', () => {
  // The data form splits on the delimiter and nothing else: the outer pipes of
  // `| a |` are cells of their own. Only the visual form (§6a) strips them.
  const t = table('=== table {format=csv delim="|"}\nSeg|Q1\nA|1\n===');
  assert.deepEqual(t.columns, ["Seg", "Q1"]);
  assert.deepEqual(t.rows[0].map((c) => c.text), ["A", "1"]);
  const outer = table('=== table {format=csv delim="|"}\n| Seg |\n| A |\n===');
  assert.deepEqual(outer.columns, ["", "Seg", ""]);
});

test("delim= that is not exactly one character is an error, natural one used (§6)", () => {
  for (const bad of [";;", "\\t", ""]) {
    const d = parse(`=== table {format=csv delim="${bad}"}\nA,B\n1,2\n===`);
    assert.ok(
      errors(d).some((e) => e.code === "bad-table-delimiter" && /exactly one character/.test(e.message)),
      `delim="${bad}" must be a bad-table-delimiter error`,
    );
    // The table still parses, on the format's own delimiter.
    assert.deepEqual(d.children[0].table.columns, ["A", "B"], `delim="${bad}" did not fall back to \`,\``);
  }
  // `format=tsv` says so in its own terms.
  const tsv = parse('=== table {format=tsv delim=";;"}\nA\tB\n===');
  assert.ok(errors(tsv).some((e) => e.code === "bad-table-delimiter" && /a tab instead/.test(e.message)));
});

test("delim= on a table with no data format is an ignored-table-delimiter warning (§6)", () => {
  // `delim` refines the data form; it does not select it. The body is a visual
  // grid, and the warning is what tells the author `format=csv` is missing.
  const d = parse('=== table {delim=";"}\nSeg;Q1\n===');
  assert.equal(errors(d).length, 0);
  assert.ok(d.diagnostics.some((x) => x.severity === "warning" && x.code === "ignored-table-delimiter"));
  assert.deepEqual(d.children[0].table.columns, ["A"]);
});

test("delim= is a registered attribute on table and diagram (no unknown-attribute)", () => {
  for (const src of [
    '=== table {format=csv delim=";"}\nA;B\n===',
    '=== diagram {format=geml-chart data="d.csv" delim=";" type=bar x=A y=B}\n===',
  ]) {
    assert.equal(
      parse(src).diagnostics.filter((x) => x.code === "unknown-attribute").length, 0,
      `\`delim\` warned as unknown in: ${src}`,
    );
  }
});

test("unknown diagram format warns, known one is clean (§7)", () => {
  assert.ok(parse("=== diagram {format=bogus}\nx\n===").diagnostics.some((x) => x.severity === "warning"));
  assert.equal(parse("=== diagram {format=mermaid}\ngraph LR\n===").diagnostics.length, 0);
});

test("table src= marks external data, empty rows/columns, body not read (§6)", () => {
  const t = table('=== table {#fy format=csv src="data/fy.csv"}\n===');
  assert.equal(t.src, "data/fy.csv");
  assert.equal(t.rows.length, 0);
  assert.deepEqual(t.columns, []);
});

test("table with both src and an inline body is an error (§6)", () => {
  const d = parse('=== table {#fy format=csv src="f.csv"}\nA, B\n1, 2\n===');
  assert.ok(errors(d).some((e) => /both `src` and an inline body/.test(e.message)));
});

test("geml-chart over a table whose data did not arrive defers to render time (§6)", () => {
  // No document resolver here, so `f.csv` cannot be loaded and the model stays
  // empty. The chart must defer rather than report column errors against nothing.
  // The condition is whether the data is present — a resolvable local source IS
  // loaded at build time and its chart builds then (see table-src.test.mjs).
  const d = parse('=== table {#fy format=csv src="f.csv"}\n===\n\n=== diagram {#c format=geml-chart data=#fy type=bar x=Segment y=FY}\n===\n');
  assert.equal(errors(d).length, 0);
  const chart = d.children.find((b) => b.type === "diagram");
  assert.equal(chart.chart, undefined);
});

console.log(`\n${passed} test(s) passed.`);

// --- fence-like-line: a would-be open fence that silently became prose ---

test("bare (unbraced) attributes on a fence-like line warn instead of passing silently", () => {
  const { diagnostics } = parse('=== text {#a}\nhi\n===\n\n=== embed src=#a\n===\n');
  const w = diagnostics.filter((d) => d.code === "fence-like-line");
  assert.equal(w.length, 1, "one warning for the unbraced embed line");
  assert.equal(w[0].severity, "warning");
  assert.equal(w[0].line, 5);
  assert.match(w[0].message, /embed/);
  assert.match(w[0].message, /braced/);
});

test("fence-like-line does not fire inside a raw body, nor on a folded fence line", () => {
  const raw = parse('==== code {#ex}\n=== embed src=#a\n====\n');
  assert.equal(raw.diagnostics.filter((d) => d.code === "fence-like-line").length, 0, "raw body is verbatim");
  const folded = parse('=== table {#t format=csv header=1 \\n caption="x"}\nA,B\n1,2\n===\n');
  assert.equal(folded.diagnostics.filter((d) => d.code === "fence-like-line").length, 0, "a \-folded fence line is a fence");
});

test("fence-like-line: an unregistered type name alone is not enough (needs attribute evidence)", () => {
  const art = parse("=== decorative divider ===\n\ntext\n");
  assert.equal(art.diagnostics.filter((d) => d.code === "fence-like-line").length, 0, "unknown word: no warning");
  const known = parse("=== note this is not braced\n\ntext\n");
  assert.equal(known.diagnostics.filter((d) => d.code === "fence-like-line").length, 1, "known type: warned");
});

// --- C-01: attribute-line continuation via a trailing `\` -------------------
// A fence or heading line ending in `\` folds the following line(s) into one
// logical head before parsing (dist/geml.js scanBlocks, the folded-head arm).

test("a fence head ending in \\ folds the next line into its attributes (C-01)", () => {
  const d = parse('=== note {#a \\\ncaption="Hello"}\nbody\n===\n');
  assert.equal(errors(d).length, 0, JSON.stringify(d.diagnostics));
  assert.equal(d.children[0].id, "a");
  assert.equal(d.children[0].attrs.caption, "Hello");
});

test("C-01 folding continues over several \\-terminated lines, then stops", () => {
  const d = parse('=== note {#a \\\ncaption="x" \\\n.cls}\nbody\n===\n');
  assert.equal(errors(d).length, 0);
  assert.equal(d.children[0].attrs.caption, "x");
  assert.deepEqual(d.children[0].classes, ["cls"]);
});

test("a heading line ending in \\ folds too, so its attributes may wrap (C-01)", () => {
  const d = parse("# Title \\\n{#tid}\n\npara\n");
  assert.equal(errors(d).length, 0);
  assert.equal(d.children[0].id, "tid");
  assert.equal(d.children[0].text, "Title");
});

// --- fence-glued-text: a `=` run glued to text is neither open nor close -----

test("a `=` run glued to text warns instead of passing silently", () => {
  const d = parse("# T {#top}\n\n===dddd\n");
  const w = d.diagnostics.filter((x) => x.code === "fence-glued-text");
  assert.equal(w.length, 1, JSON.stringify(d.diagnostics));
  assert.equal(w[0].severity, "warning");
  assert.equal(w[0].line, 3);
  assert.match(w[0].message, /labeled close/);
});

test("fence-glued-text fires on a glued OPEN fence, where fence-like-line cannot", () => {
  // FENCE_LIKE needs whitespace after the `=` run, so `===note {#a}` fell
  // through both nets before this code existed.
  const d = parse("# T {#top}\n\n===note {#a}\nbody\n===\n");
  assert.equal(d.diagnostics.filter((x) => x.code === "fence-glued-text").length, 1);
  assert.equal(d.diagnostics.filter((x) => x.code === "fence-like-line").length, 0);
});

test("fence-glued-text does not fire on a close, a `=` wall, arrow art, or a spaced fence", () => {
  for (const src of [
    "=== note {#a}\nx\n===\n",        // a real bare close
    "# T {#t}\n\n====\n",             // `=` wall as prose
    "# T {#t}\n\n===> next step\n",   // arrow art: `>` is not glued text
    "=== note this is not braced\n",  // spaced: fence-like-line's job
  ]) {
    assert.equal(parse(src).diagnostics.filter((x) => x.code === "fence-glued-text").length, 0, src);
  }
});

test("a glued would-be CLOSE is swallowed as body, and the block reports unterminated", () => {
  const d = parse("=== note {#n1}\nbody\n===dddd\n\ntail\n");
  assert.equal(errors(d).filter((x) => x.code === "unterminated-block").length, 1);
});

// --- heading-attrs-trailing-text: an attribute object that is not last -------

test("text after a heading's attribute object warns and names both ids", () => {
  const d = parse("# Title {#top}aaa\n");
  const w = d.diagnostics.filter((x) => x.code === "heading-attrs-trailing-text");
  assert.equal(w.length, 1, JSON.stringify(d.diagnostics));
  assert.equal(w[0].severity, "warning");
  assert.equal(w[0].line, 1);
  assert.match(w[0].message, /#top/);            // the id the author wrote
  assert.match(w[0].message, /#title-topaaa/);   // the id the heading really has
  assert.equal(d.children[0].id, "title-topaaa");
});

test("heading-attrs-trailing-text: spaced trailing text counts, and a non-id object is reported too", () => {
  const spaced = parse("## Sec {#s} and more\n");
  assert.equal(spaced.diagnostics.filter((x) => x.code === "heading-attrs-trailing-text").length, 1);
  const kv = parse("## Sec {hidden=true} trailing\n");
  const w = kv.diagnostics.filter((x) => x.code === "heading-attrs-trailing-text");
  assert.equal(w.length, 1);
  assert.match(w[0].message, /dropped/);
});

test("heading-attrs-trailing-text does not fire on prose braces or a well-formed heading", () => {
  for (const src of [
    "# The {{key}} interpolation\n",   // interpolation, not an attribute object
    "## Set {a, b} notation\n",        // prose braces
    "## The {} case\n",                // empty group
    "## Title {#sec}\n",               // the correct shape
    "## Plain title\n",
    "# Title \\n{#tid}\n",            // C-01: folded, so the object IS last
  ]) {
    assert.equal(parse(src).diagnostics.filter((x) => x.code === "heading-attrs-trailing-text").length, 0, src);
  }
});

test("heading-attrs-trailing-text does not fire on an object QUOTED in a code span", () => {
  // A real repo doc: docs/design/specs/2026-07-30-block-transclusion-design.md
  const quoted = "# Block embed — `=== embed {src=doc.geml#id}` renders the block in place\n";
  assert.equal(parse(quoted).diagnostics.filter((x) => x.code === "heading-attrs-trailing-text").length, 0);
  assert.equal(parse("## Math $\{#a}$ trailing\n").diagnostics.filter((x) => x.code === "heading-attrs-trailing-text").length, 0);
  // An UNQUOTED object after a code span is still the real mistake.
  const real = parse("# `embed` {#top}aaa\n");
  assert.equal(real.diagnostics.filter((x) => x.code === "heading-attrs-trailing-text").length, 1);
});

test("heading-attrs-trailing-text still fires when the math or code span is ELSEWHERE on the line", () => {
  // The atom scan has to walk PAST an atom that does not contain the object.
  assert.equal(parse("## $x^2$ Sec {#s}aaa\n").diagnostics.filter((x) => x.code === "heading-attrs-trailing-text").length, 1);
  assert.equal(parse("## Sec {#s}aaa $x^2$\n").diagnostics.filter((x) => x.code === "heading-attrs-trailing-text").length, 1);
});

test("heading-attrs-trailing-text: the atom scan survives escapes and unclosed runs", () => {
  const fires = (src) => parse(src).diagnostics.filter((x) => x.code === "heading-attrs-trailing-text").length;
  const BS = String.fromCharCode(92);   // one literal backslash, no source escapes
  assert.equal(fires(`## Sec ${BS}$x {#s}aaa\n`), 1, "an escaped char opens nothing");
  assert.equal(fires("## `unclosed {#s}aaa\n"), 1, "an unclosed code run is literal, not an atom");
  assert.equal(fires("## $unclosed {#s}aaa\n"), 1, "an unclosed math run likewise");
  assert.equal(fires("## Sec } trailing\n"), 0, "a `}` with no `{` before it is not an object");
});

test("heading-attrs-trailing-text clips a long object quoted back at the author", () => {
  const long = "#" + "s".repeat(60);
  const w = parse(`## Sec {${long}}aaa\n`).diagnostics.filter((x) => x.code === "heading-attrs-trailing-text");
  assert.equal(w.length, 1);
  assert.match(w[0].message, /…/, "the quoted object is clipped");
  assert.ok(w[0].message.length < 400, "the message stays readable in a terminal");
});

// --- A: an object the line ends with `}` but never pairs up ------------------
// `# T {#top}aaa}` defeated the first version of this check: it looked at the
// LAST `}`, which here pairs with nothing, so the object that lost the id (one
// `}` to the left) went unseen and `check` was green with two ids gone.

test("heading-attrs-trailing-text fires when a stray `}` ends the line", () => {
  const fires = (src) => parse(src).diagnostics.filter((x) => x.code === "heading-attrs-trailing-text");
  for (const src of ["## T {#a}x}\n", "## T {#a}}\n", "## T {#a}x}}\n"]) {
    const w = fires(src);
    assert.equal(w.length, 1, src + " -> " + JSON.stringify(parse(src).diagnostics));
    assert.match(w[0].message, /#a/, "names the id the author wrote");
  }
  assert.equal(fires("## T {#a}{#b}\n").length, 0, "two objects: the LAST one is the attributes (§4), nothing lost silently");
});

test("heading-attrs-unclosed fires on an object with no closing brace", () => {
  const w = parse("## T {#a\n").diagnostics.filter((x) => x.code === "heading-attrs-unclosed");
  assert.equal(w.length, 1);
  assert.equal(w[0].severity, "warning");
  assert.match(w[0].message, /#a/);
  assert.match(w[0].message, /#t-a/, "names the derived id it fell back to");
  for (const quiet of ["## Set { for x in y\n", "## T #a}\n", "## T {a\n", "## Title {#sec}\n"]) {
    assert.equal(parse(quiet).diagnostics.filter((x) => x.code === "heading-attrs-unclosed").length, 0, quiet);
  }
});

// --- B: an UNREGISTERED type name with attribute evidence -------------------
// `=== aaa}` used to be completely silent while `=== note}` warned, and
// `=== aaa` (no brace) warns as unknown-block-type — so one stray `}` bought
// total silence for the whole line.

test("fence-like-line fires on an unregistered type name carrying attribute evidence", () => {
  for (const line of ["=== aaa}", "=== aaa {", "=== aaa {#a}x", "=== aaa src=#a"]) {
    const d = parse("# T {#t}\n\n" + line + "\nbody\n===\n");
    const w = d.diagnostics.filter((x) => x.code === "fence-like-line");
    assert.equal(w.length, 1, line + " -> " + JSON.stringify(d.diagnostics));
    assert.equal(w[0].line, 3);
  }
});

test("fence-like-line stays quiet on `=` art, which carries no attribute evidence", () => {
  for (const line of ["=== decorative divider ===", "===== 表格 =====", "=== two words here"]) {
    const d = parse("# T {#t}\n\n" + line + "\nbody\n===\n");
    assert.equal(d.diagnostics.filter((x) => x.code === "fence-like-line").length, 0, line);
  }
});

// --- fence-like-line: the cause decides the message ------------------------
// `=== code {` is a habit, not a slip (brace opened, meant to close later), and
// "attributes must be braced" told its author to do what they had just done.

test("fence-like-line names the cause: unclosed object, trailing text, stray `}`, no braces", () => {
  const msg = (line) => {
    const w = parse("# T {#t}\n\n" + line + "\nbody\n===\n").diagnostics.filter((x) => x.code === "fence-like-line");
    assert.equal(w.length, 1, line);
    return w[0].message;
  };
  for (const line of ["=== code {", "=== code {lang=js", "=== note {#a"]) {
    assert.match(msg(line), /never closed by/, line);
    assert.match(msg(line), /fold the object/, line + " points at the `\` continuation");
  }
  assert.match(msg("=== aaa {#a}x"), /text follows its attribute object/);
  assert.match(msg("=== aaa}"), /pairs with no/);
  assert.match(msg("=== embed src=#a"), /attributes must be braced/);
});
