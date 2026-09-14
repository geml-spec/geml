// Unit tests for GEML -> Typst converter (to-typst.ts). Run with `npm test`.
import { strict as assert } from "node:assert";
import { parse, gemlToTypst } from "../dist/geml.js";
import { escText, escString, sanitizeLabel } from "../dist/to-typst.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const typ = (src, opts) => gemlToTypst(parse(src), opts);

test("to-typst: metadata and preamble options", () => {
  const src = `=== meta
title = "My Paper"
author = "Alice & Bob"
lang = "en"
paper = "us-letter"
===
# Introduction {#intro}
Hello world.
`;
  const { typst } = typ(src);
  assert.match(typst, /#set document\(title: "My Paper", author: \("Alice & Bob",\)\)/);
  assert.match(typst, /#set page\(paper: "us-letter", numbering: "1"\)/);
  assert.match(typst, /#set text\(lang: "en"\)/);
  assert.match(typst, /#set heading\(numbering: "1\.1"\)/);
  assert.match(typst, /= Introduction <intro>/);
});

test("to-typst: heading numbering can be disabled via meta", () => {
  const src = `=== meta
numbering = false
===
# Chapter 1
Text
`;
  const { typst } = typ(src);
  assert.doesNotMatch(typst, /#set heading\(numbering/);
  assert.match(typst, /= Chapter 1/);
});

test("to-typst: headings levels 1 to 6 and id sanitization", () => {
  const src = `
# H1 {#h1}
## H2 {#h2}
### H3 {#h3}
#### H4 {#h4}
##### H5 {#h5}
###### H6 {#h6}
`;
  const { typst } = typ(src);
  assert.match(typst, /= H1 <h1\>/);
  assert.match(typst, /== H2 <h2\>/);
  assert.match(typst, /=== H3 <h3\>/);
  assert.match(typst, /==== H4 <h4\>/);
  assert.match(typst, /===== H5 <h5\>/);
  assert.match(typst, /====== H6 <h6\>/);
});

test("to-typst: inline formatting (emph, strong, strike, code, math, break)", () => {
  const src = `
Paragraph with *italic*, **bold**, ~~strike~~, \`code\`, $E=mc^2$ and line\\
break.
`;
  const { typst } = typ(src);
  assert.match(typst, /_italic_/);
  assert.match(typst, /\*bold\*/);
  assert.match(typst, /#strike\[strike\]/);
  assert.match(typst, /`code`/);
  assert.match(typst, /\$E=mc\^2\$/);
  assert.match(typst, /line\\ \nbreak/);
});

test("to-typst: escaping special characters in text and strings", () => {
  assert.equal(escText("foo * bar _ baz ` qux $ 10 # tag [a] <b@c>"), "foo \\* bar \\_ baz \\` qux \\$ 10 \\# tag \\[a\\] \\<b\\@c\\>");
  assert.equal(escString('a "quoted" \\ string'), 'a \\"quoted\\" \\\\ string');
  assert.equal(sanitizeLabel("sec:1.2-alpha_beta"), "sec-1-2-alpha_beta");
});

test("to-typst: links, autoref, project, and footnotes", () => {
  const src = `
# Header {#hdr}
External [Link](https://example.com)
Internal [Anchor](#hdr)
Cross [Doc](other.geml#sec)
Autoref [[#hdr]]
Cross autoref [[other.geml#remote]]
Footnote reference[^fn1]
`;
  const { typst } = typ(src);
  assert.match(typst, /#link\("https:\/\/example\.com"\)\[Link\]/);
  assert.match(typst, /#link\(<hdr>\)\[Anchor\]/);
  assert.match(typst, /#link\("other\.geml#sec"\)\[Doc\]/);
  assert.match(typst, /@hdr/);
  assert.match(typst, /#link\("other\.geml#remote"\)/);
  assert.match(typst, /#footnote\[#link\(<fn1>\)\[#fn1\]\]/);
});

test("to-typst: images with and without caption", () => {
  const src = `
![With Alt](img1.png)
![](img2.png)
`;
  const { typst } = typ(src);
  assert.match(typst, /#figure\(image\("img1\.png"\), caption: \[With Alt\]\)/);
  assert.match(typst, /#image\("img2\.png"\)/);
});

test("to-typst: lists (unordered, ordered, tasks, nested)", () => {
  const src = `
- Item A
- Item B
  - Sub 1
  - Sub 2

1. Step 1
2. Step 2

- [x] Done
- [ ] Todo
`;
  const { typst } = typ(src);
  assert.match(typst, /- Item A/);
  assert.match(typst, /  - Sub 1/);
  assert.match(typst, /\+ Step 1/);
  assert.match(typst, /- \[x\] Done/);
  assert.match(typst, /- \[ \] Todo/);
});

test("to-typst: table with alignments, summary row, caption, and id", () => {
  const src = `=== table {#facts format=csv}
Left, Center, Right
1, 2, 3
4, 5, 6
===

=== view {#tbl src=#facts caption="Stats" summary="Left = 'Total'; Right = sum(Right)"}
===
`;
  const { typst } = typ(src);
  assert.match(typst, /#figure\(/);
  assert.match(typst, /table\(/);
  assert.match(typst, /columns: \(auto, auto, auto\)/);
  assert.match(typst, /table\.header\(\[Left\], \[Center\], \[Right\]\)/);
  assert.match(typst, /\[1\], \[2\], \[3\]/);
  assert.match(typst, /table\.hline\(\)/);
  assert.match(typst, /\[Total\], \[\], \[9\]/);
  assert.match(typst, /caption: \[Stats\]/);
  assert.match(typst, /<tbl>/);
});

test("to-typst: math block with id", () => {
  const src = `=== math {#eq-pyth}
a^2 + b^2 = c^2
===
`;
  const { typst } = typ(src);
  assert.match(typst, /\$ a\^2 \+ b\^2 = c\^2 \$ <eq-pyth>/);
});

test("to-typst: code block with language, caption, and backtick fence", () => {
  const src = `=== code {#code-ex lang=python caption="Python Script"}
\`\`\`
code with inner backticks
\`\`\`
===
`;
  const { typst } = typ(src);
  assert.match(typst, /#figure\(/);
  assert.match(typst, /````python/);
  assert.match(typst, /caption: \[Python Script\]/);
  assert.match(typst, /<code-ex>/);
});

test("to-typst: callout notes (warning, error, tip, important, default)", () => {
  const src = `
=== note {.warning}
Warning text
===

=== note {.error}
Danger text
===

=== note {.tip}
Tip text
===

=== note {.important}
Important text
===

=== note
Default note text
===

=== text {#prose}
Addressable prose block
===
`;
  const { typst } = typ(src);
  assert.match(typst, /#callout\(title: \[Warning\], stroke: rgb\("f59e0b"\)/);
  assert.match(typst, /#callout\(title: \[Danger\], stroke: rgb\("ef4444"\)/);
  assert.match(typst, /#callout\(title: \[Tip\], stroke: rgb\("10b981"\)/);
  assert.match(typst, /#callout\(title: \[Important\], stroke: rgb\("8b5cf6"\)/);
  assert.match(typst, /#callout\(title: \[Note\], stroke: rgb\("3b82f6"\)/);
  assert.match(typst, /Addressable prose block <prose>/);
});

test("to-typst: data blocks and hidden blocks", () => {
  const src = `
=== data {#data-json format=json}
{"key": "value"}
===

=== note {hidden}
Should be dropped
===
`;
  const { typst, notes } = typ(src);
  assert.match(typst, /```json/);
  assert.match(typst, /<data-json>/);
  assert.doesNotMatch(typst, /Should be dropped/);
  assert.ok(notes.some((n) => /dropped/.test(n)));
});

test("to-typst: embed expansion via resolveEmbed", () => {
  const src = `=== embed {src=other.geml#section}
===
`;
  const { typst: resolved } = typ(src, {
    resolveEmbed: (src) => `Resolved content for ${src}`,
  });
  assert.match(resolved, /Resolved content for other\.geml#section/);

  const { typst: unresolvable } = typ(src);
  assert.match(unresolvable, /#link\("other\.geml#section"\)\[other\.geml\\#section\]/);

  const { typst: emptyEmbed } = typ("=== embed\n===\n");
  assert.equal(emptyEmbed.trim(), "// Generated by @geml/geml --to typst\n#set page(paper: \"a4\", numbering: \"1\")\n#set heading(numbering: \"1.1\")\n#set math.equation(numbering: \"(1)\")\n\n#let callout(body, title: none, stroke: luma(180), fill: luma(250)) = block(\n  fill: fill,\n  stroke: (left: 3pt + stroke),\n  inset: (x: 10pt, y: 8pt),\n  radius: (right: 3pt),\n  width: 100%,\n  breakable: true,\n)[\n  #if title != none [*#title* \\ ]\n  #body\n]");
});

test("to-typst: diagrams, unknown blocks, and bare code/table", () => {
  const src = `
=== code
plain code with no lang
===

=== diagram {format=mermaid}
graph LR
A --> B
===

=== custom
unknown block content
===

=== table
| Simple |
|:-------|
| Cell   |
===
`;
  const { typst } = typ(src);
  assert.match(typst, /```\nplain code with no lang/);
  assert.match(typst, /```mermaid\ngraph LR/);
  assert.match(typst, /```custom\nunknown block content/);
  assert.match(typst, /#table\(/);
});

console.log(`${passed} to-typst tests passed.`);
