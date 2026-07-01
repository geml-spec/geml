// CLI HTML renderer (render.ts) tests: exercise the self-contained output —
// every chart type drawn as inline SVG (incl. negative values and a size
// channel), the diagram fallbacks, output/code/math blocks, tables, notes,
// lists, and inline constructs. This is the path `geml render` uses.
import { parse, renderHtml } from "../dist/geml.js";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const DOC = `# Render tour {#top}

=== table {#data format=csv header=1}
Cat, A, B
X, 3, 5
Y, 7, 2
Z, 4, 6
===

=== table {#neg format=csv header=1}
K, V
P, -3
Q, 5
===

=== diagram {format=geml-chart data=#data type=bar x=Cat y=A}
===

=== diagram {format=geml-chart data=#data type=line x=Cat y=A}
===

=== diagram {format=geml-chart data=#data type=area x=Cat y=A}
===

=== diagram {format=geml-chart data=#data type=scatter x=A y=B size=A}
===

=== diagram {format=geml-chart data=#data type=pie x=Cat y=A}
===

=== diagram {format=geml-chart data=#neg type=bar x=K y=V}
===

=== diagram {#flow format=mermaid}
graph LR
  A --> B
===

=== diagram {#gv format=graphviz}
digraph { a -> b }
===

=== diagram {#d2 format=d2}
x -> y
===

=== code {#c lang=js}
const a = 1;
===

=== output {of=#c}
1
===

=== math {#m}
c^2 = a^2 + b^2
===

=== note {.warning}
A note with *em*, a [link](https://example.com), an image ![pic](p.png), a video ![v](clip.mp4), an auto-ref [[#data]], and a footnote.[^f]
===

1. first
2. second
   - nested

Prose between the two lists so they stay separate.

- [x] done
- [ ] todo

[^f]: the footnote text.
`;

const html = renderHtml(parse(DOC), { source: "tour.geml" });

test("emits a self-contained HTML document with inlined CSS", () => {
  assert.match(html, /<html/i);
  assert.match(html, /<style/i);
});

test("every chart type renders as inline SVG (incl. negatives + size channel)", () => {
  const svgs = (html.match(/<svg\b/g) || []).length;
  assert.ok(svgs >= 6, `expected >=6 chart SVGs, got ${svgs}`);
  assert.match(html, /<rect\b/, "bar → <rect>");
  assert.match(html, /<circle\b/, "scatter → <circle>");
  assert.match(html, /<path\b/, "pie/area → <path>");
});

test("diagram fallbacks: mermaid placeholder + unbundled DSLs kept as source", () => {
  assert.match(html, /class="mermaid"/, "mermaid placeholder");
  assert.match(html, /digraph/, "graphviz body preserved");
  assert.match(html, /x -&gt; y|x -> y/, "d2 body preserved");
});

test("blocks: table, note (.warning), math, code, output, heading", () => {
  assert.ok((html.match(/<table\b/g) || []).length >= 2, "both tables");
  assert.match(html, /callout note[^"]*warning/, "note carries its .warning class");
  assert.match(html, /math-block/, "math block");
  assert.match(html, /class="output"/, "output block");
  assert.match(html, /<h1[^>]*id="top"/, "heading with id");
});

test("inline + lists: link, image, video, footnote, ordered + task lists", () => {
  assert.match(html, /href="https:\/\/example\.com"/, "link");
  assert.match(html, /<img[^>]+p\.png/, "image embed");
  assert.match(html, /clip\.mp4/, "video embed");
  assert.match(html, /class="fn"/, "footnote reference");
  assert.match(html, /<ol\b/, "ordered list");
  assert.match(html, /type="checkbox"/, "task-list checkbox");
});

console.log(`\n${passed} test(s) passed.`);
