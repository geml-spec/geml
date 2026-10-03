// GEML -> Markdown exporter (to-md.js): parse real GEML, assert the projection.
import { parse, gemlToMd, mdToGeml } from "../dist/geml.js";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const md = (src) => gemlToMd(parse(src));

test("meta hoists to a single YAML frontmatter at the top", () => {
  const { md: out } = md('=== meta\ntitle = "Demo"\nn = 3\n===\n\n# H\n');
  assert.match(out, /^---\ntitle: Demo\nn: 3\n---\n/);
  assert.match(out, /# H/);
});

test("a remote table has no rows at build time, and the export names its source (§3.3)", () => {
  const { md: out } = md('=== table {#t src="https://example.com/a.csv"}\n===\n');
  assert.match(out, /\*External data `https:\/\/example\.com\/a\.csv` — loaded at render time\.\*/);
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

test("a table cell's pipe gets one backslash in front, whatever backslashes precede it (escPipe)", () => {
  // Cell text `c\\|d` renders `c\|d`; its Markdown is `c\\|d`. GitHub drops the
  // one backslash right before a pipe and keeps the rest for the inline parse, so
  // `c\\\|d` renders `c\|d` again — doubling the run first would add a backslash.
  const { md: out } = md("=== table {format=csv delim=;}\nh1;h2\na;c\\\\|d\n===\n");
  assert.match(out, /\| c\\\\\\\|d \|/, "one backslash added, in front of the pipe");
  const back = parse(mdToGeml(out).geml).children.find((b) => b.type === "table").table.rows[0][1];
  assert.equal(back.text, "c\\\\|d", "and GEML's own reading of the row gives the cell back");
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

// ---------------------------------------------------------------- 覆盖率补位

test("a src= table the parser could not read emits its header, caption and a note", () => {
  const { md: out, notes } = md('=== table {#c src="missing.csv" caption="Sales"}\n===\n');
  assert.ok(notes.some((n) => /could not be read; emitted header only/.test(n)), notes.join("\n"));
  assert.ok(out.includes("*Sales*"), out);
});

test("a short row is padded to the header's width", () => {
  const { md: out } = md("=== table {#t format=csv header=1}\na,b\n1\n===\n");
  assert.match(out, /\| 1 \|\s*\|/, out);
});

test("an embed with no src= produces nothing but says why", () => {
  const { md: out, notes } = md("=== embed {#e}\n===\n");
  assert.equal(out.trim(), "");
  assert.ok(notes.some((n) => /could not be resolved/.test(n)), notes.join("\n"));
});

// --- the document title (doc-title.ts) ---------------------------------------
// The spec keeps the title in `=== meta` and lets every heading be a section;
// Markdown wants the title as the h1 and sections from h2. The projection maps
// one shape onto the other — and never counts h1s to guess which is the title.

test("meta title becomes the h1 and the body's headings move down one level", () => {
  const { md: out, notes } = md('=== meta\ntitle = "Demo"\n===\n\n# One\n\ntext\n\n## One-a\n\n# Two\n');
  assert.match(out, /^---\ntitle: Demo\n---\n\n# Demo\n\n## One\n\ntext\n\n### One-a\n\n## Two\n$/);
  assert.ok(!notes.some((n) => /clamped/.test(n)), "nothing to clamp");
});

test("a first heading that echoes the title IS the title: nothing added, nothing moves", () => {
  const { md: out } = md('=== meta\ntitle = "Demo"\n===\n\n# {{title}} {#top}\n\n## Ch\n');
  assert.equal(out.split("# Demo").length, 2, "the title appears once");
  assert.match(out, /\n# Demo\n\n## Ch\n$/);
});

test("no meta title: the projection is unchanged (an author's h1 stays an h1)", () => {
  const { md: out } = md('=== meta\nn = 3\n===\n\n# Own Title\n\n## S\n');
  assert.match(out, /^---\nn: 3\n---\n\n# Own Title\n\n## S\n$/);
  assert.match(md("# Own\n\n## S\n").md, /^# Own\n\n## S\n$/, "no meta at all");
});

test("a title that is not a string, or is empty, is no title", () => {
  assert.match(md('=== meta\ntitle = 42\n===\n\n# A\n').md, /\n# A\n$/);
  assert.match(md('=== meta\ntitle = ""\n===\n\n# A\n').md, /\n# A\n$/);
});

test("a hidden first heading is skipped when looking for the echo", () => {
  const { md: out } = md('=== meta\ntitle = "Demo"\n===\n\n# Demo {hidden}\n\n# Real\n');
  assert.match(out, /\n# Demo\n\n## Real\n$/);
});

test("Markdown specials in the title are escaped in the h1", () => {
  assert.match(md('=== meta\ntitle = "a*b_c"\n===\n\n# S\n').md, /\n# a\\\*b\\_c\n\n## S\n$/);
});

test("a level-6 heading under a title is clamped, and the clamp is reported", () => {
  const { md: out, notes } = md('=== meta\ntitle = "T"\n===\n\n###### Deep\n');
  assert.match(out, /\n###### Deep\n$/);
  assert.ok(notes.some((n) => /clamped to level 6/.test(n)), notes.join("; "));
});

test("embedded: no frontmatter, no title of its own, headings at the host's shift", () => {
  const doc = parse('=== meta\ntitle = "Borrowed"\n===\n\n# Sec\n\n## Sub\n');
  assert.equal(gemlToMd(doc, { embedded: true, headingShift: 1 }).md, "## Sec\n\n### Sub\n");
  assert.equal(gemlToMd(doc, { embedded: true }).md, "# Sec\n\n## Sub\n", "no shift asked for, none applied");
});

test("the resolver is told the host's shift", () => {
  const doc = parse('=== meta\ntitle = "Host"\n===\n\n=== embed {src=#x}\n===\n');
  const seen = [];
  const { md: out } = gemlToMd(doc, { resolveEmbed: (src, attrs, host) => { seen.push([src, host]); return "## from resolver"; } });
  assert.deepEqual(seen, [["#x", { headingShift: 1 }]]);
  assert.match(out, /\n# Host\n\n## from resolver\n$/);
});

console.log(`\n${passed} test(s) passed.`);
