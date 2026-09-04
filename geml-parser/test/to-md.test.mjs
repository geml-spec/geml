// GEML -> Markdown exporter (to-md.js): parse real GEML, assert the projection.
import { parse, gemlToMd } from "../dist/geml.js";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const md = (src) => gemlToMd(parse(src));

test("meta hoists to a single YAML frontmatter at the top", () => {
  const { md: out } = md('=== meta\ntitle = "Demo"\nn = 3\n===\n\n# H\n');
  assert.match(out, /^---\ntitle: Demo\nn: 3\n---\n/);
  assert.match(out, /# H/);
});

test("headings, emphasis, code, links project to Markdown", () => {
  const { md: out } = md("# Title\n\nA *em* **strong** `c` [x](#y).\n");
  assert.match(out, /^# Title/m);
  assert.match(out, /\*em\* \*\*strong\*\* `c` \[x\]\(#y\)/);
});

test("a computed relation renders as GFM with computed cells and summary row", () => {
  // GEP-0012: the computed columns and the report row belong to a `view`, and
  // `--to md` must carry them exactly as it carried a table's — that export
  // used to drop a view entirely, as an empty ```view fence.
  const src = `=== table {#facts format=csv header=1}
Segment, Q1, Q2
Cloud, 10, 20
Edge, 30, 40
===

=== view {#fy src=#facts compute="FY = Q1 + Q2" summary="Segment = 'Total'; FY = sum(FY)"}
===
`;
  const { md: out } = md(src);
  assert.match(out, /\| Segment \| Q1 \| Q2 \| FY \|/);
  assert.match(out, /\| Cloud \| 10 \| 20 \| 30 \|/);   // FY computed = 30
  assert.match(out, /\| Total \|  \|  \| 100 \|/);       // summary sum = 100
});

test("code/math/mermaid project to fenced blocks", () => {
  assert.match(md("=== code {lang=python}\nx=1\n===\n").md, /```python\nx=1\n```/);
  assert.match(md("=== math\na=b\n===\n").md, /\$\$\na=b\n\$\$/);
  assert.match(md("=== diagram {format=mermaid}\ngraph LR\nA-->B\n===\n").md, /```mermaid\ngraph LR/);
});

test("a `text` block exports as plain paragraphs, not a blockquote", () => {
  const { md: out } = md("=== text {#p}\nFirst **para**.\n\nSecond para.\n===\n");
  assert.match(out, /^First \*\*para\*\*\./m);
  assert.match(out, /^Second para\./m);
  assert.doesNotMatch(out, /^>/m, "no `> ` quoting for text blocks");
  assert.doesNotMatch(out, /```/, "not the unknown-type fenced fallback");
});

test("a `note` block still exports as a blockquote", () => {
  const { md: out } = md("=== note\ncareful now\n===\n");
  assert.match(out, /^> careful now/m);
});

test("a footnote note projects to a Markdown footnote definition", () => {
  const { md: out } = md("see[^n]\n\n=== note {#n .footnote}\nthe body\n===\n");
  assert.match(out, /see\[\^n\]/);
  assert.match(out, /\[\^n\]: the body/);
});

test("geml-chart degrades to a descriptor and reports a note", () => {
  const src = `=== table {#fy format=csv header=1}\nA, B\n1, 2\n===\n\n=== diagram {format=geml-chart data=#fy type=bar x=A y=B}\n===\n`;
  const { md: out, notes } = md(src);
  assert.match(out, /```geml-chart\ntype=bar data=#fy/);
  assert.ok(notes.some((n) => /geml-chart/.test(n)), "lossy note reported");
});

test("`{hidden}` blocks are dropped from the projection", () => {
  const { md: out, notes } = md("# H\n\n=== note {hidden}\nsecret\n===\n");
  assert.doesNotMatch(out, /secret/);
  assert.ok(notes.some((n) => /hidden/.test(n)));
});

test("lists project with ordered / task / nested markers", () => {
  const ord = md("1. one\n2. two\n").md;
  assert.match(ord, /1\. one/);
  assert.match(ord, /2\. two/);
  const task = md("- [x] done\n- [ ] todo\n  - nested\n").md;
  assert.match(task, /- \[x\] done/);
  assert.match(task, /- \[ \] todo/);
  assert.match(task, /- nested/);
});

test("a heading id is dropped with a loss note", () => {
  const { md: out, notes } = md("# Title {#top}\n");
  assert.match(out, /^# Title/m);
  assert.ok(notes.some((n) => /heading id/.test(n)), "id-drop noted");
});

test("an unknown block type is preserved as a fenced block with a note", () => {
  const { md: out, notes } = md("=== sidebar\narbitrary body\nmore\n===\n");
  assert.match(out, /```sidebar\narbitrary body\nmore\n```/);
  assert.ok(notes.some((n) => /unknown block type/.test(n)), "unknown-type noted");
});

test("a table cell's backslash run before a pipe is doubled so the escape survives (escPipe)", () => {
  // Cell text `c\\|d`: the run of backslashes would eat the added `\|` escape,
  // so the exporter doubles the run — `c\\\\\|d` reads back as the same cell.
  const { md: out } = md("=== table {format=csv delim=;}\nh1;h2\na;c\\\\|d\n===\n");
  assert.match(out, /c\\\\\\\\\\\|d/, "backslash run doubled, pipe escape appended");
});

test("a soft-wrapped list item stays ONE item in Markdown, wrap intact (§2.2)", () => {
  const { md: out } = md("- **bold spanning\n  a line break** tail.\n- plain item, hard wrapped\n  onto a second line\n");
  // The wrap survives as a continuation line indented to the content column —
  // which GFM reads as the same single item — and the emphasis pairs across it,
  // so no asterisk is left over to be escaped.
  assert.match(out, /- \*\*bold spanning\n  a line break\*\* tail\./, "emphasis pairs across the wrap");
  assert.match(out, /- plain item, hard wrapped\n  onto a second line/, "continuation stays attached");
  assert.doesNotMatch(out, /\\\*/, "nothing degraded to escaped asterisks");
  assert.doesNotMatch(out, /wrapped\n\n/, "no blank line splits an item from its continuation");
});

test("an ordered wrapped item aligns its continuation under the content column", () => {
  const { md: out } = md("3. third, wrapped\n   over here\n");
  assert.match(out, /3\. third, wrapped\n   over here/, "three-space continuation for a `3. ` marker");
});

console.log(`\n${passed} test(s) passed.`);
