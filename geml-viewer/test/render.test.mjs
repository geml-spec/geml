// Renderer tests: parse real GEML and assert the produced DOM. Uses linkedom
// for a document; render.js is pure (no KaTeX/Mermaid), so this runs in Node.
import { parse } from "../../geml-parser/dist/geml.js";
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

const TABLE = `=== table {#fy format=csv header=1 compute="FY = Q1 + Q2" summary="Segment = 'Total'; FY = sum(FY)"}
Segment, Q1, Q2
Cloud, 10, 20
Hardware, 30, 40
===
`;

test("table: header, computed column, summary row", () => {
  const root = render(TABLE);
  const table = root.querySelector("table");
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

test("graphviz diagram falls back to a labelled source block", () => {
  const root = render("=== diagram {#g format=graphviz}\ndigraph { a -> b }\n===\n");
  assert.equal(root.querySelector(".geml-mermaid"), null);
  const tag = root.querySelector(".geml-tag");
  assert.ok(tag && /graphviz/.test(tag.textContent));
  assert.match(root.querySelector("pre").textContent, /digraph/);
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

test("note is a blockquote; aside is a distinct <aside>", () => {
  const root = render("=== note {#n}\nhi\n===\n\n=== aside {#a}\nby the way\n===\n");
  const note = root.querySelector("blockquote.geml-note");
  const aside = root.querySelector("aside.geml-aside");
  assert.ok(note && /hi/.test(note.textContent), "note → blockquote.geml-note");
  assert.ok(aside && /by the way/.test(aside.textContent), "aside → aside.geml-aside");
  assert.equal(root.querySelector("aside.geml-note"), null, "aside is not rendered as a note");
});

console.log(`\n${passed} test(s) passed.`);

