// Conversion coverage against larger, element-rich Markdown fixtures.
// Run with `npm test`.
import { mdToGeml, parse } from "../dist/geml.js";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(here, "fixtures", name), "utf8");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }
const errors = (d) => d.diagnostics.filter((x) => x.severity === "error");

test("kitchen sink: every construct converts and parses with zero errors", () => {
  const { geml, notes } = mdToGeml(read("kitchensink.md"));
  const doc = parse(geml);
  assert.equal(errors(doc).length, 0, JSON.stringify(doc.diagnostics));

  // YAML frontmatter -> meta
  const meta = doc.children.find((b) => b.type === "meta");
  assert.equal(meta.data.version, 3);

  // footnote definition -> a flow note block the [^note] ref resolves to
  assert.match(geml, /=== note \{#note\}/);

  // autolink -> GEML link
  assert.match(geml, /\[https:\/\/commonmark\.org\]\(https:\/\/commonmark\.org\)/);

  // GFM column alignment carried into the table model
  const table = doc.children.find((b) => b.type === "table");
  assert.deepEqual(table.table.align, ["left", "center", "right"]);

  // embedded GEML example: inner `===` forces a longer outer fence
  assert.match(geml, /^==== code \{#code-\d+ lang=geml\}$/m);

  // mermaid fence -> diagram block (§7), not a code block
  const diagram = doc.children.find((b) => b.type === "diagram");
  assert.equal(diagram.attrs.format, "mermaid");

  // media kind inferred from the source extension (§5.1)
  const media = [];
  for (const b of doc.children) for (const n of b.inlines ?? []) if (n.type === "image") media.push(n.as);
  assert.deepEqual(media.sort(), ["audio", "image", "video"]);

  // typed blocks get auto-generated ids so they are referenceable
  assert.ok(doc.ids.includes("math-1") && doc.ids.includes("diagram-1"));

  // only the thematic-break drop is expected as a note
  assert.ok(notes.every((n) => /thematic break/.test(n)), JSON.stringify(notes));
});

test("real-world doc: §8 flags dangling links the source relies on", () => {
  // John Gruber's "Markdown: Syntax" — its TOC points at hand-authored HTML
  // anchors (#html, #block, …) with no in-document target. Conversion succeeds;
  // the reference checker correctly reports the dangling links.
  const { geml } = mdToGeml(read("markdown-syntax.md"));
  assert.ok(geml.length > 1000);
  const errs = errors(parse(geml));
  assert.ok(errs.length >= 10, `expected many dangling refs, got ${errs.length}`);
  assert.ok(errs.every((e) => /unresolved reference|cannot resolve document/.test(e.message)),
    errs.map((e) => e.message).join("\n"));
});

console.log(`\n${passed} test(s) passed.`);
