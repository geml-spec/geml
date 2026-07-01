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

test("a computed table renders as GFM with computed cells and summary row", () => {
  const src = `=== table {format=csv header=1 compute="FY = Q1 + Q2" summary="Segment = 'Total'; FY = sum(FY)"}
Segment, Q1, Q2
Cloud, 10, 20
Edge, 30, 40
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

console.log(`\n${passed} test(s) passed.`);
