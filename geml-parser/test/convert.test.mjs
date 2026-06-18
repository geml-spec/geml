// Markdown -> GEML conversion checks. Run with `npm test`.
import { mdToGeml, parse } from "../dist/geml.js";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const conv = (md) => mdToGeml(md).geml;

test("YAML frontmatter -> === meta", () => {
  const g = conv("---\ntitle: My Doc\ndraft: true\nn: 2\n---\n\nbody\n");
  assert.match(g, /=== meta/);
  assert.match(g, /title="My Doc"/);
  assert.match(g, /draft=true/);
  assert.match(g, /n=2/);
});

test("fenced code -> === code {lang=…} with auto-id", () => {
  const g = conv("```python\nx = 1\n```\n");
  assert.match(g, /=== code \{#code-1 lang=python\}/);
  assert.match(g, /x = 1/);
});

test("known diagram DSL fences -> === diagram {format=…}", () => {
  const g = conv("```mermaid\ngraph LR\nA-->B\n```\n");
  assert.match(g, /=== diagram \{#diagram-1 format=mermaid\}/);
});

test("fence grows past `===` lines in the body", () => {
  const g = conv("```\na\n===\nb\n```\n");
  assert.match(g, /^==== code/m); // longer fence to clear the body's ===
});

test("blockquote -> === note", () => {
  const g = conv("> line one\n> line two\n");
  assert.match(g, /=== note \{#note-1\}\nline one\nline two\n===/);
});

test("GFM table -> === table (visual body)", () => {
  const g = conv("| A | B |\n|---|--:|\n| 1 | 2 |\n");
  assert.match(g, /=== table \{#table-1\}\n\| A \| B \|/);
  const t = parse(g).children[0].table;
  assert.deepEqual(t.columns, ["A", "B"]);
  assert.equal(t.align[1], "right");
});

test("setext headings -> ATX", () => {
  const g = conv("Title\n=====\n\nSub\n---\n");
  assert.match(g, /^# Title$/m);
  assert.match(g, /^## Sub$/m);
});

test("display math -> === math", () => {
  assert.match(conv("$$\nE=mc^2\n$$\n"), /=== math \{#math-1\}\nE=mc\^2\n===/);
});

test("thematic break is dropped with a note", () => {
  const r = mdToGeml("a\n\n---\n\nb\n");
  assert.doesNotMatch(r.geml, /^---$/m);
  assert.ok(r.notes.some((n) => /thematic break/.test(n)));
});

test("heading with inline code gets a pinned GitHub-style id, TOC resolves", () => {
  const md = "1. [`.x` 文档](#3-x-文档)\n\n## 3. `.x` 文档\n";
  const g = conv(md);
  assert.match(g, /## 3\. `\.x` 文档 \{#3-x-文档\}/);
  assert.equal(parse(g).diagnostics.filter((d) => d.severity === "error").length, 0);
});

test("`<…>` inside inline code is not reported as raw HTML", () => {
  const r = mdToGeml("A `blob:<id>` reference.\n");
  assert.equal(r.notes.filter((n) => /raw HTML/.test(n)).length, 0);
});

test("converted Markdown round-trips through the parser cleanly", () => {
  const md = "---\ntitle: T\n---\n\n## H {#h}\n\nText [link](#h) and `code`.\n\n```js\n1\n```\n\n| X | Y |\n|---|---|\n| 1 | 2 |\n";
  const doc = parse(conv(md));
  assert.equal(doc.diagnostics.filter((d) => d.severity === "error").length, 0, JSON.stringify(doc.diagnostics));
});

console.log(`\n${passed} test(s) passed.`);
