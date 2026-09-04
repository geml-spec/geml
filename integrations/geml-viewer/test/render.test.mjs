// Renderer tests: parse real GEML and assert the produced DOM. Uses linkedom
// for a document; render.js is pure (no KaTeX/Mermaid), so this runs in Node.
import { parse } from "../../../geml-parser/dist/geml.js";
import { renderDocument, viewerDiagnostics } from "../src/render.js";
import { parseHTML } from "linkedom";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

function render(src) {
  const { document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
  const root = renderDocument(parse(src), document);
  return root;
}

// GEP-0012: the computed column and the report row belong to a `view`, and the
// viewer must draw one exactly as it draws a table — it is the same model.
const TABLE = `=== table {#facts format=csv header=1}
Segment, Q1, Q2
Cloud, 10, 20
Hardware, 30, 40
===

=== view {#fy src=#facts compute="FY = Q1 + Q2" summary="Segment = 'Total'; FY = sum(FY)"}
===
`;

test("view: header, computed column, summary row", () => {
  const root = render(TABLE);
  // The document holds two relations now — the facts and the view over them —
  // and the derived one is what this pins. A viewer that skipped `view` drew
  // only the first, which is how the gap showed up.
  const tables = [...root.querySelectorAll("table")];
  assert.equal(tables.length, 2, "both the source table and the view are drawn");
  const table = tables[1];
  assert.ok(table, "table rendered");
  const heads = [...table.querySelectorAll("thead th")].map((th) => th.textContent);
  assert.deepEqual(heads, ["Segment", "Q1", "Q2", "FY"]);
  const bodyRows = table.querySelectorAll("tbody tr");
  assert.equal(bodyRows.length, 3); // 2 data + 1 summary
  // FY computed cell on first row = 30, flagged computed + numeric
  const cloudCells = bodyRows[0].querySelectorAll("td");
  const fy = cloudCells[cloudCells.length - 1];
  assert.equal(fy.textContent, "30");
  assert.match(fy.className, /geml-computed/);
  assert.match(fy.className, /geml-num/);
  // summary row
  const summary = bodyRows[2];
  assert.match(summary.className, /geml-summary/);
  assert.equal(summary.querySelector("td").textContent, "Total");
});

test("geml-chart renders an inline SVG bound to the table", () => {
  const root = render(TABLE + `\n=== diagram {#c format=geml-chart data=#fy type=bar x=Segment y=FY}\n===\n`);
  const svg = root.querySelector(".geml-chart svg");
  assert.ok(svg, "chart svg rendered");
  assert.ok(svg.querySelectorAll("rect").length >= 2, "bars drawn for each segment");
});

test("mermaid diagram becomes an upgradeable placeholder with its source", () => {
  const root = render("=== diagram {#d format=mermaid}\ngraph LR\n  A --> B\n===\n");
  const m = root.querySelector(".geml-mermaid");
  assert.ok(m, "mermaid placeholder rendered");
  assert.match(m.textContent, /graph LR/);
});

// D2 / Graphviz engines are PARKED (build.mjs "PARKED ENGINES"): both formats
// take the labelled-source fallback for now. Flip these two tests back to the
// placeholder assertions when re-enabling.
test("d2 diagram falls back to a labelled source block (engine parked)", () => {
  const root = render("=== diagram {#d format=d2}\nx -> y: request\n===\n");
  assert.equal(root.querySelector(".geml-d2"), null, "no d2 placeholder while parked");
  const tag = root.querySelector(".geml-tag");
  assert.ok(tag && /d2/.test(tag.textContent), "labelled with its format");
  assert.match(root.querySelector("pre").textContent, /x -> y: request/);
});

test("graphviz diagram falls back to a labelled source block (engine parked)", () => {
  for (const fmt of ["graphviz", "dot"]) {
    const root = render(`=== diagram {#g format=${fmt}}\ndigraph { a -> b }\n===\n`);
    assert.equal(root.querySelector(".geml-graphviz"), null, `no placeholder for format=${fmt} while parked`);
    const tag = root.querySelector(".geml-tag");
    assert.ok(tag && new RegExp(fmt).test(tag.textContent), `labelled with ${fmt}`);
    assert.match(root.querySelector("pre").textContent, /digraph \{ a -> b \}/);
  }
});

test("plantuml diagram falls back to a labelled source block", () => {
  const root = render("=== diagram {#p format=plantuml}\n@startuml\nA -> B\n@enduml\n===\n");
  assert.equal(root.querySelector(".geml-mermaid"), null);
  assert.equal(root.querySelector(".geml-graphviz"), null);
  const tag = root.querySelector(".geml-tag");
  assert.ok(tag && /plantuml/.test(tag.textContent));
  assert.match(root.querySelector("pre").textContent, /@startuml/);
});

test("math block becomes a KaTeX placeholder carrying the TeX", () => {
  const root = render("=== math {#m}\ny = a x + b\n===\n");
  const m = root.querySelector(".geml-math-display");
  assert.ok(m);
  assert.equal(m.getAttribute("data-tex"), "y = a x + b");
});

test("inline markup: strong / em / code / link / autoref", () => {
  const root = render("Text **bold** *em* `c` [x](#n) and [[#n]].\n\n=== note {#n}\nhi\n===\n");
  assert.equal(root.querySelector("strong").textContent, "bold");
  assert.equal(root.querySelector("em").textContent, "em");
  assert.equal(root.querySelector("code").textContent, "c");
  assert.equal(root.querySelector('a[href="#n"]').textContent, "x");
});

test("dangling reference surfaces an error diagnostic banner", () => {
  const root = render("=== note {#n}\nsee [[#missing]]\n===\n");
  const err = root.querySelector(".geml-diag-error");
  assert.ok(err, "error banner rendered");
  assert.match(err.textContent, /missing/);
});

test("document metadata block is not rendered as content", () => {
  const root = render('=== meta\ntitle = "T"\n===\n\n# Heading\n');
  assert.equal(root.querySelector("h1").textContent, "Heading");
  assert.match(root.innerHTML, /Heading/);
  assert.doesNotMatch(root.innerHTML, /title = "T"/);
});

test("viewer hides 'no document resolver' cross-doc warnings, keeps the rest", () => {
  const diags = [
    { severity: "warning", message: "cross-document reference `COMPARISON.md` not checked (no document resolver)", line: 3 },
    { severity: "warning", message: "chart: `size` is ignored for type `bar`", line: 5 },
    { severity: "error", message: "unresolved reference `#missing`", line: 7 },
  ];
  const kept = viewerDiagnostics(diags);
  assert.equal(kept.length, 2);
  assert.ok(kept.some((d) => /size/.test(d.message)), "real warning kept");
  assert.ok(kept.some((d) => d.severity === "error"), "error kept");
  assert.ok(!kept.some((d) => /no document resolver/.test(d.message)), "resolver warning dropped");
});

test("src table that wasn't inlined renders a placeholder, not an empty table", () => {
  const root = render('=== table {#fy format=csv src="d.csv"}\n===\n');
  assert.equal(root.querySelector("table"), null);
  const tag = root.querySelector(".geml-tag");
  assert.ok(tag && /src/.test(tag.textContent));
  assert.match(root.innerHTML, /Data not loaded from d\.csv/);
});

test("task-list items render checkboxes; done items are marked", () => {
  const root = render("- [ ] open\n- [x] done\n- plain\n");
  const boxes = root.querySelectorAll('li input[type="checkbox"]');
  assert.equal(boxes.length, 2, "one checkbox per task item, none for the plain item");
  assert.equal(boxes[0].hasAttribute("checked"), false);
  assert.equal(boxes[1].hasAttribute("checked"), true);
  assert.ok(boxes[0].hasAttribute("disabled"), "checkboxes are read-only");
  const done = root.querySelector("li.geml-task-done");
  assert.ok(done && /done/.test(done.textContent), "done item carries geml-task-done");
});

test("nested list under a list item is rendered, not dropped", () => {
  const root = render("- outer\n  - inner\n");
  const nested = root.querySelector("li ul, li ol");
  assert.ok(nested, "nested list rendered inside the item");
  assert.match(nested.textContent, /inner/);
});

test("note renders as a blockquote callout", () => {
  const root = render("=== note {#n}\nhi there\n===\n");
  const note = root.querySelector("blockquote.geml-note");
  assert.ok(note && /hi there/.test(note.textContent), "note → blockquote.geml-note");
});

// --- single-block focus (URL #id) -----------------------------------------

function renderFocus(src, id) {
  const { document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
  return renderDocument(parse(src), document, id);
}

const MULTI = `# Intro {#intro}

=== note {#a}
first, see [[#b]]
===

=== note {#b caption="Second Block"}
second
===

## Sub {#sub}

=== note {#c}
third
===
`;

test("focus: a typed block renders ALONE, with a back-to-full banner", () => {
  const root = renderFocus(MULTI, "b");
  assert.equal(root.querySelectorAll(".geml-note").length, 1, "only one note rendered");
  assert.ok(/second/.test(root.querySelector("#b")?.textContent || ""), "#b is the one shown");
  assert.ok(!root.querySelector("#a"), "#a not rendered");
  const banner = root.querySelector(".geml-focus-banner");
  assert.ok(banner && banner.querySelector("a.geml-focus-full"), "focus banner + view-full link");
});

test("focus: labels resolve from the FULL model — a [[#b]] inside the shown #a keeps #b's caption", () => {
  const root = renderFocus(MULTI, "a");
  const link = root.querySelector("#a a");
  assert.ok(link, "the [[#b]] auto-ref rendered as a link");
  // If labels came only from the focused slice (#a), this would fall back to the
  // bare id "b"; it is "Second Block" only because the FULL model built labels.
  assert.equal(link.textContent, "Second Block", "auto-ref text = #b's caption, from the full model");
});

test("focus: a heading id brings its whole SECTION", () => {
  const root = renderFocus(MULTI, "sub");
  assert.ok(root.querySelector("#sub"), "the heading itself");
  assert.ok(root.querySelector("#c"), "the section's block #c");
  assert.ok(!root.querySelector("#a") && !root.querySelector("#intro"), "nothing outside the section");
});

test("focus: an unknown id falls back to the full document (never blank, no banner)", () => {
  const root = renderFocus(MULTI, "nope");
  assert.ok(root.querySelector("#a") && root.querySelector("#b") && root.querySelector("#c"), "full doc");
  assert.ok(!root.querySelector(".geml-focus-banner"), "no banner when nothing focused");
});

console.log(`\n${passed} test(s) passed.`);


// --- data blocks (GEP-0005): labelled preview, jsonl tail, src placeholder ---

test("data json: labelled preview with the body shown", () => {
  const root = render('=== data {#cfg}\n{"retries": 3}\n===\n');
  const wrap = root.querySelector(".geml-data");
  assert.ok(wrap, "data block rendered");
  assert.equal(wrap.querySelector(".geml-tag").textContent, "data json");
  assert.match(wrap.querySelector("pre code").textContent, /"retries": 3/);
});

test("data jsonl: the TAIL is open and the earlier records FOLD — none are dropped", () => {
  const recs = Array.from({ length: 130 }, (_, i) => `{"i":${i}}`).join("\n");
  const root = render(`=== data {#log format=jsonl}\n${recs}\n===\n`);
  const wrap = root.querySelector(".geml-data");
  assert.equal(wrap.querySelector(".geml-tag").textContent, "data jsonl");

  const fold = wrap.querySelector("details.geml-data-more");
  assert.ok(fold, "past the open bound the overflow folds");
  assert.match(fold.querySelector("summary").textContent, /30 earlier lines of 130/);
  assert.match(fold.querySelector("pre code").textContent, /\{"i":0\}/,
    "the oldest record is in the page, behind the fold — it used to be dropped");

  // A log folds ABOVE its open tail, so the LAST <pre> is the open one.
  const pres = [...wrap.querySelectorAll("pre code")];
  assert.equal(pres.length, 2, "one folded pre, one open");
  assert.match(pres[1].textContent, /\{"i":129\}/, "newest record open");
});

test("data json: the overflow folds below, and a short block does not fold at all", () => {
  const rows = Array.from({ length: 130 }, (_, i) => `  {"i": ${i}}`).join(",\n");
  const wrap = render(`=== data {#big}\n[\n${rows}\n]\n===\n`).querySelector(".geml-data");
  const fold = wrap.querySelector("details.geml-data-more");
  assert.ok(fold, "132 lines is past the bound");
  assert.match(fold.querySelector("summary").textContent, /32 more lines of 132/);
  assert.match(fold.querySelector("pre code").textContent, /\{"i": 129\}/, "the last record is present");
  const pres = [...wrap.querySelectorAll("pre code")];
  assert.match(pres[0].textContent, /\{"i": 0\}/, "json reads from the top, so the head is what is open");

  const small = render('=== data {#s}\n{"a": 1}\n===\n').querySelector(".geml-data");
  assert.equal(small.querySelector("details.geml-data-more"), null, "nothing to fold");
});

test("data with src= and no loaded value renders a placeholder, not an empty pre", () => {
  const root = render("=== data {#ext format=jsonl src=ops/latency.jsonl}\n===\n");
  const wrap = root.querySelector(".geml-data");
  assert.match(wrap.querySelector(".geml-data-note").textContent, /external data ops\/latency\.jsonl/);
  assert.equal(wrap.querySelector("pre"), null);
});

test("data feeding a chart: both render, chart svg present", () => {
  const root = render('=== data {#m format=jsonl}\n{"t":"a","v":1}\n{"t":"b","v":2}\n===\n\n=== diagram {format=geml-chart data=#m type=bar x=t y=v}\n===\n');
  assert.ok(root.querySelector(".geml-data"), "data rendered");
  assert.ok(root.querySelector(".geml-chart svg"), "chart built from records");
});

test("{hidden} blocks are in the model and never in the output", () => {
  // The spec's omission rule, pinned on this renderer because it is the THIRD
  // one carrying it (render.ts and to-md.ts are the others) and it is the one
  // that did not: a hidden glossary table rendered in the VS Code preview and
  // the browser viewer while the same document exported clean.
  const root = render(
    "=== table {#not-translated-terms hidden}\n| term | zh-cn |\n|---|---|\n| Doc-as-a-Base | 文档即真相之源 |\n===\n\nvisible paragraph\n");
  assert.equal(root.querySelector("table"), null, "the hidden table is not rendered");
  assert.doesNotMatch(root.textContent, /文档即真相之源/, "and nothing of it leaks as text");
  assert.match(root.textContent, /visible paragraph/, "the rest of the document still renders");
});

test("a %% comment line never reaches the output", () => {
  const root = render("%% an author note\n\nvisible paragraph\n");
  assert.doesNotMatch(root.textContent, /an author note/);
  assert.match(root.textContent, /visible paragraph/);
});

test("an embed awaiting translation says so in the target language", () => {
  const plain = render("=== embed {src=MANIFESTO.geml}\n===\n");
  assert.equal(plain.querySelector(".geml-transclusion a").textContent, "MANIFESTO.geml",
    "no translate-to: the bare target, as before");
  const zh = render("=== embed {src=MANIFESTO.geml translate-to=zh-cn}\n===\n");
  assert.equal(zh.querySelector(".geml-transclusion a").textContent, "MANIFESTO.geml 翻译中…");
  const other = render("=== embed {src=MANIFESTO.geml translate-to=fr}\n===\n");
  assert.equal(other.querySelector(".geml-transclusion a").textContent,
    "MANIFESTO.geml — translating…", "a language with no row falls back, never `undefined`");
});
