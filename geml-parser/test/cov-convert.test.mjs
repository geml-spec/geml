// Branch-coverage companion for the format converters: dist/to-md.js,
// dist/from-md.js, dist/serialize.js, dist/table.js, dist/inline.js,
// dist/chart.js. Each test forces branch arms the main suites leave dark
// (enumerated from the c8 baseline) and asserts the observable behavior;
// where an arm affects re-parsing, the round-trip is asserted too. Same
// conventions as test/to-md.test.mjs: the compiled dist API, in-process.
import { parse, serialize, gemlToMd, mdToGeml } from "../dist/geml.js";
import { parseTable } from "../dist/table.js";
import { buildChart } from "../dist/chart.js";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const md = (src) => gemlToMd(parse(src));
const errs = (doc) => doc.diagnostics.filter((d) => d.severity === "error");

// ---------------------------------------------------------------------------
// to-md.js
// ---------------------------------------------------------------------------

test("to-md: strike/math/image/break and every link-destination shape", () => {
  const src = [
    "# T {#t}",
    "",
    "~~x~~ $m$ ![p](i.png) [e](https://e.com/) [d](o.geml#a) [b](o.geml) [n]() [[#t]] [[o.geml#z]] end\\",
    "next",
    "",
  ].join("\n");
  const { md: out } = md(src);
  assert.match(out, /~~x~~/);
  assert.match(out, /\$m\$/);
  assert.match(out, /!\[p\]\(i\.png\)/);
  assert.match(out, /\[e\]\(https:\/\/e\.com\/\)/);
  assert.match(out, /\[d\]\(o\.geml#a\)/);      // doc + anchor
  assert.match(out, /\[b\]\(o\.geml\)/);         // doc only
  assert.match(out, /\[n\]\(\)/);                // no destination at all
  assert.match(out, /\[#t\]\(#t\)/);             // autoref -> plain link
  assert.match(out, /\[o\.geml#z\]\(o\.geml#z\)/); // cross-doc autoref
  assert.match(out, /end {2}\nnext/);            // hard break -> two spaces
});

test("to-md: table caption and left/center/right alignment separators", () => {
  const src = '=== table {caption="Cap"}\n| L | C | R | N |\n|:--|:-:|--:|---|\n| 1 | 2 | 3 | 4 |\n===\n';
  const { md: out } = md(src);
  assert.match(out, /\*Cap\*/);
  assert.match(out, /\| :--- \| :--: \| ---: \| --- \|/);
});

test("to-md: external-src table emits header only with a loss note", () => {
  const { md: out, notes } = md("=== table {src=ext.csv}\n===\n");
  assert.ok(notes.some((n) => /external source/.test(n)));
  assert.match(out, /\|  \|/); // empty header row: nothing to inline
});

// A cell a formula cannot read as a number counts as 0 so one dirty row does
// not void the column (§6) — but the substitution is a WARNING naming that
// cell, not silence. This used to abort the whole column with an error, which
// is why the row below has a computed value at all.
test("to-md: a non-numeric cell counts as 0 and says which cell it was", () => {
  const doc = parse('=== table {format=csv compute="C = B"}\nA,B\n1,2\n3,x\n===\n');
  assert.deepEqual(errs(doc), [], "a dirty cell does not fail the build");
  const warn = doc.diagnostics.find((d) => d.code === "compute-non-numeric-cell");
  assert.ok(warn, "the substitution is reported");
  assert.match(warn.message, /column `B` row 2/, "the warning names the cell, not just the column");
  assert.match(warn.message, /counted as 0/);

  const { md: out } = gemlToMd(doc);
  assert.match(out, /\| A \| B \| C \|/);
  assert.match(out, /\| 1 \| 2 \| 2 \|/);
  assert.match(out, /\| 3 \| x \| 0 \|/, "the substituted 0 is what the table now claims");
});

test("to-md: a short data row is padded to the column count", () => {
  const doc = parse('=== table {format=csv}\nA,B,C\n1,2,3\n4\n===\n');
  const { md: out } = gemlToMd(doc);
  assert.match(out, /\| 4 \|  \|  \|/, "missing trailing cells are padded, not dropped");
});

test("to-md: loose list items are separated by a blank line", () => {
  const { md: out } = md("- a\n\n- b\n");
  assert.equal(out, "- a\n\n- b\n");
});

test("to-md: code body containing a backtick fence gets a longer fence", () => {
  const { md: out } = md("=== code\n```\nx\n===\n");
  assert.match(out, /````\n```\nx\n````/);
});

test("to-md: geml-chart descriptor stringifies non-string attr values", () => {
  const src = "=== table {#t format=csv}\n1,B\na,2\n===\n\n=== diagram {format=geml-chart type=bar data=#t x=1 y=B}\n===\n";
  const doc = parse(src);
  assert.equal(errs(doc).length, 0, JSON.stringify(doc.diagnostics));
  const dia = doc.children.find((b) => b.kind === "block" && b.type === "diagram");
  assert.equal(dia.chart.x, "1"); // numeric attr resolved as the "1" column
  const { md: out, notes } = gemlToMd(doc);
  assert.match(out, /```geml-chart\ntype=bar data=#t x=1 y=B\n```/);
  assert.ok(notes.some((n) => /geml-chart/.test(n)));
});

test("to-md: a format-less diagram exports as a bare fence, an unknown type as a tagged one", () => {
  // `output` used to be a registered type exporting a BARE fence. It was
  // withdrawn, so it now takes the unknown-type path — which keeps the body and
  // tags the fence with the type, so nothing is silently lost.
  const { md: out, notes } = md("=== output\n42\n===\n\n=== diagram\nD\n===\n");
  assert.match(out, /```output\n42\n```/, "an unknown type keeps its name on the fence");
  assert.match(out, /```\nD\n```/, "a format-less diagram still has nothing to tag with");
  assert.ok(notes.some((n) => /unknown block type/.test(n)), `expected a loss note, got ${JSON.stringify(notes)}`);
});

test("to-md: hidden headings and %% lines are dropped", () => {
  const { md: out, notes } = md("# Gone {hidden}\n\nkeep\n\n%% scratch\n\ntail\n");
  assert.doesNotMatch(out, /Gone|scratch/);
  assert.match(out, /keep/);
  assert.match(out, /tail/);
  assert.ok(notes.some((n) => /hidden heading/.test(n)));
});

test("to-md: meta value with YAML-unsafe characters is JSON-quoted", () => {
  const { md: out } = md('=== meta\nk = "v: w"\n===\n\nbody\n');
  assert.match(out, /^---\nk: "v: w"\n---\n/);
});

test("to-md: a plain note becomes a blockquote with blank quote lines", () => {
  const { md: out } = md("=== note\nfirst\n\nsecond\n===\n");
  assert.match(out, /^> first\n>\n> second$/m);
});

test("to-md: optional model fields (children/raw/data) default to empty", () => {
  // The public Block type marks children/raw/data optional; a hand-built
  // document (as an agent or tool may produce) must not crash the exporter.
  const doc = { kind: "document", ids: [], diagnostics: [], children: [
    { kind: "block", type: "note", mode: "flow", id: "fn", classes: ["footnote"], attrs: {} },
    { kind: "block", type: "note", mode: "flow", classes: [], attrs: {} },
    { kind: "block", type: "code", mode: "raw", classes: [], attrs: {} },
    { kind: "block", type: "meta", mode: "data", classes: [], attrs: {} },
    { kind: "list", ordered: false, items: [{ text: "i", inlines: [{ type: "text", value: "i" }],
      children: [{ kind: "paragraph", text: "p", inlines: [{ type: "text", value: "p" }] }] }] },
  ] };
  const { md: out } = gemlToMd(doc);
  assert.match(out, /\[\^fn\]:/);      // footnote note without children
  assert.match(out, /^>$/m);            // plain flow note without children
  assert.match(out, /```\n```/);        // raw block without raw lines
  assert.doesNotMatch(out, /^---$/m);   // meta without data -> no frontmatter
  assert.match(out, /- i\np/);          // non-list child of a list item
});

// ---------------------------------------------------------------------------
// from-md.js
// ---------------------------------------------------------------------------

test("from-md: frontmatter quoted/empty values and unconvertible lines", () => {
  const r = mdToGeml("---\nempty:\ndq: \"A B\"\nsq: 'C D'\n- junk\n\n---\nbody\n");
  assert.match(r.geml, /empty=""/);
  assert.match(r.geml, /dq="A B"/);
  assert.match(r.geml, /sq="C D"/);
  assert.ok(r.notes.some((n) => /frontmatter line not converted: - junk/.test(n)));
  // the blank frontmatter line is skipped without a note
  assert.equal(r.notes.filter((n) => /not converted/.test(n)).length, 1);
  const meta = parse(r.geml).children.find((b) => b.kind === "block" && b.type === "meta");
  assert.deepEqual(meta.data, { empty: "", dq: "A B", sq: "C D" });
});

test("from-md: unterminated code/math fences run to EOF; newline appended", () => {
  const c = mdToGeml("```js\nx = 1"); // no close, no trailing newline
  assert.match(c.geml, /=== code \{#code-1 lang=js\}\nx = 1\n===\n$/);
  const m = mdToGeml("$$\ne=1");
  assert.match(m.geml, /=== math \{#math-1\}\ne=1\n===\n$/);
});

test("from-md: footnote definition folds indented continuation lines", () => {
  const r = mdToGeml("[^a]:\n  first\n  second\nplain after\n");
  assert.match(r.geml, /=== note \{#a\}\nfirst\nsecond\n===\nplain after\n/);
});

// ---------------------------------------------------------------------------
// serialize.js
// ---------------------------------------------------------------------------

test("serialize: boolean attr arms — bare flag and explicit false", () => {
  const out = serialize(parse("=== note {flag off=false}\nx\n===\n"));
  assert.match(out, /=== note \{flag off=false\}/);
  const back = parse(out).children[0];
  assert.equal(back.attrs.flag, true);
  assert.equal(back.attrs.off, false);
});

test("serialize: code span containing a backtick keeps a longer fence", () => {
  const doc = parse("a `` x`y `` b\n");
  const out = serialize(doc);
  assert.match(out, /`` x`y ``/);
  assert.deepEqual(parse(out).children, doc.children); // round-trip
});

test("serialize: doc-only link, empty link, cross-doc autoref round-trip", () => {
  const src = "[d](o.geml) and [n]() and [[o.geml#z]]\n";
  const out = serialize(parse(src));
  assert.equal(out, src);
  const link = parse(out).children[0].inlines.find((n) => n.type === "link" && n.doc !== undefined);
  assert.equal(link.doc, "o.geml");
  assert.equal(link.anchor, undefined);
});

test("serialize: optional model fields and Block[] input", () => {
  const out = serialize([
    { kind: "heading", level: 2, text: "T", inlines: [{ type: "text", value: "T" }], classes: [], attrs: {} },
    { kind: "block", type: "note", mode: "flow", classes: [], attrs: {} },
    { kind: "block", type: "meta", mode: "data", classes: [], attrs: {} },
    { kind: "block", type: "code", mode: "raw", classes: [], attrs: {} },
    { kind: "list", ordered: false, items: [{ text: "i", inlines: [{ type: "text", value: "i" }],
      children: [{ kind: "paragraph", text: "p", inlines: [{ type: "text", value: "p" }] }] }] },
  ]);
  assert.match(out, /^## T$/m);            // heading with no id/attrs at all
  assert.match(out, /=== note\n\n===/);    // children undefined -> one empty line
  assert.match(out, /=== meta\n===/);      // data undefined
  assert.match(out, /=== code\n===/);      // raw undefined
  assert.match(out, /- i\np/);             // serBlock child inside a list item
  assert.equal(errs(parse(out)).length, 0); // still parses cleanly
});

test("serialize: a bare %% hidden line keeps no trailing space", () => {
  const out = serialize(parse("a\n\n%%\n\nb\n"));
  assert.match(out, /^%%$/m);
  const back = parse(out);
  assert.equal(back.children.length, 3);
  assert.equal(back.children[1].text, "");
});

// ---------------------------------------------------------------------------
// table.js
// ---------------------------------------------------------------------------

test("table: separator-first visual grid is headerless with letter columns", () => {
  const t = parse("=== table\n|---|---|\n| 1 | 2 |\n===\n").children[0].table;
  assert.deepEqual(t.columns, ["A", "B"]);
  assert.equal(t.header, false);
  assert.equal(t.rows[0][1].value, 2);
  const t2 = parse("=== table\n|:--|--:|\n===\n").children[0].table;
  assert.deepEqual(t2.columns, ["A", "B"]); // width from the alignment row
  assert.deepEqual(t2.align, ["left", "right"]);
});

test("table: csv header=0, tsv tabs, unknown format, ragged row", () => {
  const csv = parse("=== table {format=csv header=0}\n1,2\n===\n").children[0].table;
  assert.equal(csv.header, false);
  assert.deepEqual(csv.columns, ["A", "B"]);
  const tsv = parse("=== table {format=tsv}\na\tb\n1\t2\n===\n").children[0].table;
  assert.deepEqual(tsv.columns, ["a", "b"]);
  assert.equal(tsv.rows[0][1].value, 2);
  const doc = parse("=== table {format=xml}\n| a |\n===\n");
  assert.ok(doc.diagnostics.some((d) => /unknown table format `xml`/.test(d.message)));
  const ragged = parse("=== table {format=csv}\nA,B\n1\n===\n").children[0].table;
  assert.equal(ragged.rows[0][1].text, ""); // short row -> empty cell
});

test("table: src table respects an explicit header attribute", () => {
  const t = parse("=== table {src=x.csv header=0}\n===\n").children[0].table;
  assert.equal(t.header, false);
  assert.equal(t.src, "x.csv");
});

test("table: compute display formats %d/%e/%g/%f and %% literal", () => {
  const t = parse('=== table {format=csv compute="D [%d] = A; E [%.1e] = A; G [%g] = A; F [%f] = A; P [%.1f%%] = A/B*100"}\nA,B\n2.5,5\n===\n').children[0].table;
  const cell = (name) => t.rows[0][t.columns.indexOf(name)].text;
  assert.equal(cell("D"), "3");        // %d rounds, no precision
  assert.equal(cell("E"), "2.5e+0");   // %e with precision
  assert.equal(cell("G"), "2.5");      // %g -> String
  assert.equal(cell("F"), "2.500000"); // %f default precision 6
  assert.equal(cell("P"), "50.0%");    // %% literal percent
});

test("table: compute evaluator error arms produce diagnostics", () => {
  const doc = parse('=== table {format=csv compute="X = 1 +; N = -A; P2 = (1; S = sum(1); M = max(A, B); U = sum(Zz); T = ); R = 1 2; noequals"}\nA,B\n2.5,5\n===\n');
  const msgs = doc.diagnostics.map((d) => d.message);
  const has = (re) => assert.ok(msgs.some((m) => re.test(m)), String(re));
  has(/compute `X`: unexpected end of formula/);
  has(/compute `P2`: missing \)/);
  has(/compute `S`: bad argument to sum\(\)/);
  has(/compute `M`: missing \)/);          // comma after the aggregate arg
  has(/compute `U`: unknown column `Zz`/);
  has(/compute `T`: unexpected token `\)`/);
  has(/compute `R`: trailing tokens in formula/);
  has(/bad compute formula `noequals`/);
  const t = doc.children[0].table; // the one good formula: unary minus
  assert.equal(t.rows[0][t.columns.indexOf("N")].value, -2.5);
});

test("table: count/avg/min/max aggregates and sum over a text column", () => {
  const doc = parse('=== table {format=csv compute="K = count(A); V = avg(B)" summary="A = min(A); B = max(B); T = sum(T)"}\nA,B,T\n1,4,x\n3,2,y\n===\n');
  assert.equal(errs(doc).length, 0, JSON.stringify(doc.diagnostics));
  const t = doc.children[0].table;
  assert.equal(t.rows[0][t.columns.indexOf("K")].value, 2); // count
  assert.equal(t.rows[0][t.columns.indexOf("V")].value, 3); // avg of 4,2
  const sm = (name) => t.summary[t.columns.indexOf(name)];
  assert.equal(sm("A").value, 1); // min
  assert.equal(sm("B").value, 4); // max
  assert.equal(sm("T").value, 0); // no numeric values -> 0
});

test("table: summary error arms — bad decl, unknown target, generic hint", () => {
  const doc = parse('=== table {format=csv summary="oops; Qq = 1; A = (1"}\nA\n1\n===\n');
  const msgs = doc.diagnostics.map((d) => d.message);
  assert.ok(msgs.some((m) => /bad summary `oops`/.test(m)));
  assert.ok(msgs.some((m) => /summary targets unknown column `Qq`/.test(m)));
  assert.ok(msgs.some((m) => /summary `A`: missing \)/.test(m)));
});

// The table `span=` attribute was withdrawn (parseSpan, the span declarations
// and the `bad-span` diagnostic are gone from §6 and the parser), so the arms
// this once covered no longer exist. A leftover `span=` is now an ordinary
// unknown attribute — carried on the block, meaningless to the model.
test("table: a withdrawn `span=` attribute is inert, not an error", () => {
  const doc = parse('=== table {format=csv span="r1c1:2x1"}\nA,B\n1,2\n===\n');
  assert.deepEqual(errs(doc), []);
  assert.equal(doc.children[0].table.rows[0][0].span, undefined, "no cell carries a span");
});

test("table: double-quoted compute target name is unquoted", () => {
  // GEML's attr tokenizer cannot carry an inner double quote, so this arm is
  // reached through the exported parseTable API directly.
  const { model, diagnostics } = parseTable(["A", "1"], { format: "csv", compute: '"C 2" = A * 2' }, 1, { refs: [] });
  assert.equal(diagnostics.length, 0);
  assert.ok(model.columns.includes("C 2"));
  assert.equal(model.rows[0][model.columns.indexOf("C 2")].value, 2);
});

// ---------------------------------------------------------------------------
// inline.js
// ---------------------------------------------------------------------------

test("inline: unbalanced constructs stay literal text", () => {
  const one = (src) => parse(src).children[0].inlines;
  assert.deepEqual(one("before [x](oops end\n"), [{ type: "text", value: "before [x](oops end" }]);
  assert.deepEqual(one("a `b\n"), [{ type: "text", value: "a `b" }]);   // unclosed code span
  assert.deepEqual(one("![oops\n"), [{ type: "text", value: "![oops" }]); // unclosed image bracket
  assert.deepEqual(one("a\\b\n"), [{ type: "text", value: "a\\b" }]);   // escape of a non-punct char
});

test("inline: line-final backslash at end of input is a hard break", () => {
  const ns = parse("end\\\n").children[0].inlines;
  assert.deepEqual(ns, [{ type: "text", value: "end" }, { type: "break" }]);
});

test("inline: link attribute object — kept when closed, literal when not", () => {
  const ns = parse("[x](#t){k=1 .c}\n\n# T {#t}\n").children[0].inlines;
  assert.equal(ns[0].type, "link");
  assert.equal(ns[0].attrs.k, 1);
  const ns2 = parse("[y](#t){oops\n\n# T {#t}\n").children[0].inlines;
  assert.equal(ns2[0].type, "link");
  assert.equal(ns2[1].value, "{oops"); // unclosed attr object stays text
});

test("inline: rule of three — runs both multiples of three still pair", () => {
  const ns = parse("a***b***c\n").children[0].inlines;
  assert.deepEqual(ns, [
    { type: "text", value: "a" },
    { type: "emph", children: [{ type: "strong", children: [{ type: "text", value: "b" }] }] },
    { type: "text", value: "c" },
  ]);
  assert.equal(serialize(parse("a***b***c\n")), "a***b***c\n"); // round-trip
});

// ---------------------------------------------------------------------------
// chart.js
// ---------------------------------------------------------------------------

test("chart: y listing no columns is an error", () => {
  const doc = parse('=== table {#t format=csv}\nA,B\n1,2\n===\n\n=== diagram {format=geml-chart type=bar data=#t x=A y=","}\n===\n');
  assert.ok(errs(doc).some((d) => /`y` lists no columns/.test(d.message)));
});

test("chart: rows with an empty numeric cell are skipped", () => {
  const doc = parse("=== table {#t format=csv}\nX,Y\na,1\nb,\nc,3\n===\n\n=== diagram {format=geml-chart type=line data=#t x=X y=Y}\n===\n");
  const dia = doc.children.find((b) => b.kind === "block" && b.type === "diagram");
  assert.deepEqual(dia.chart.dataset.categories, ["a", "c"]);
  assert.deepEqual(dia.chart.dataset.numbers.Y, [1, 3]);
});

test("chart: rows lacking a cell skip or blank the channel", () => {
  // A short data row simply has no C — the chart must tolerate a missing cell
  // per channel. (This once came from a failed `compute`, which aborted the
  // whole column; a non-numeric cell now counts as 0, so every row has one.)
  const table = '=== table {#r format=csv}\nA,B,C\n1,2,3\n4,5\n===\n';
  const chart = (spec) => {
    const doc = parse(table + "\n=== diagram {format=geml-chart " + spec + "}\n===\n");
    return doc.children.find((b) => b.kind === "block" && b.type === "diagram").chart;
  };
  const c1 = chart("type=bar data=#r x=A y=C"); // y missing -> row skipped
  assert.deepEqual(c1.dataset.categories, ["1"]);
  assert.deepEqual(c1.dataset.numbers.C, [3]);
  const c2 = chart("type=bar data=#r x=C y=A"); // x missing -> "" category
  assert.deepEqual(c2.dataset.categories, ["3", ""]);
  const c3 = chart("type=bar data=#r x=A y=A series=C"); // series missing -> ""
  assert.deepEqual(c3.dataset.seriesOf, ["3", ""]);
});

test("chart: buildChart without a data attr yields an empty dataRef", () => {
  const t = parse("=== table {format=csv}\nA,B\na,1\n===\n").children[0].table;
  const { model, diagnostics } = buildChart({ type: "bar", x: "A", y: "B" }, t);
  assert.equal(diagnostics.length, 0);
  assert.equal(model.dataRef, "");
});

console.log(`\n${passed} test(s) passed.`);
