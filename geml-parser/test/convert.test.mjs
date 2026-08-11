// Markdown -> GEML conversion checks. Run with `npm test`.
import { spawnSync } from "node:child_process";
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

test("fence grows past an indented === line in the body", () => {
  const g = conv("```\n    ===\n```\n");
  assert.match(g, /^==== code/m); // indented === still bumps the fence length
});

test("indented inner fence is content, not an early close (CommonMark)", () => {
  // The inner ``` is indented 12 spaces, so it is body content, not a close.
  const md = '```\nMarkdown    ```py\n            print("hi")\n            ```\nGEML        === code\n            ===\n```\n';
  const g = conv(md);
  const doc = parse(g);
  const codes = doc.children.filter((b) => b.type === "code");
  assert.equal(codes.length, 1); // one block, not split at the inner fence
  assert.equal(doc.diagnostics.filter((d) => d.severity === "error").length, 0);
  assert.match(g, /print\("hi"\)/);
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

test("GFM task lists survive conversion and parse as checked items (§5)", () => {
  const items = parse(conv("- [x] shipped\n- [ ] pending\n")).children[0].items;
  assert.deepEqual(items.map((i) => i.checked), [true, false]);
});

test("literal {{name}} in md prose converts escaped — md has no interpolation (§4)", () => {
  const g = conv("Use {{name}} syntax to reference variables.\n");
  assert.match(g, /Use \\\{\{name\}\} syntax/);
  const doc = parse(g);
  assert.equal(doc.diagnostics.filter((d) => d.severity === "error").length, 0);
  assert.equal(doc.children[0].inlines.map((n) => n.value ?? "").join(""), "Use {{name}} syntax to reference variables.");
});

test("{{name}} in md prose is NOT captured by a frontmatter key of the same name", () => {
  // In Markdown the braces are plain text; conversion must not let the
  // generated `=== meta` block silently substitute them.
  const doc = parse(conv("---\ntitle: Acme\n---\n\nSay {{title}} out loud.\n"));
  assert.equal(doc.diagnostics.filter((d) => d.severity === "error").length, 0);
  const para = doc.children.find((b) => b.kind === "paragraph");
  assert.equal(para.inlines.map((n) => n.value ?? "").join(""), "Say {{title}} out loud.");
});

test("{{name}} inside md inline code / fenced code converts unescaped (raw either way)", () => {
  const g = conv("The `{{name}}` form.\n\n```\n{{name}}\n```\n");
  assert.match(g, /`\{\{name\}\}`/);        // code span kept verbatim
  assert.match(g, /^\{\{name\}\}$/m);       // fenced body kept verbatim
  assert.equal(parse(g).diagnostics.filter((d) => d.severity === "error").length, 0);
});

test("an md-escaped \\{{name}} is not double-escaped", () => {
  const g = conv("Literal \\{{name}} stays.\n");
  assert.match(g, /Literal \\\{\{name\}\} stays/);
  assert.doesNotMatch(g, /\\\\\{/);
});

test("literal {{name}} inside md inline math converts unescaped (math is verbatim)", () => {
  const g = conv("Let $x_{{n}}$ hold and {{k}} too.\n");
  assert.match(g, /\$x_\{\{n\}\}\$/);       // math kept verbatim
  assert.match(g, /and \\\{\{k\}\} too/);   // prose still escaped
  assert.equal(parse(g).diagnostics.filter((d) => d.severity === "error").length, 0);
});

test("{{name}} in md table cells converts unescaped (raw table body)", () => {
  const g = conv("| a | {{k}} |\n|---|---|\n| 1 | {{v}} |\n");
  assert.match(g, /\| a \| \{\{k\}\} \|/);
  assert.doesNotMatch(g, /\\\{\{/);
  assert.equal(parse(g).diagnostics.filter((d) => d.severity === "error").length, 0);
});

test("setext and code-bearing ATX headings escape {{name}} like any prose", () => {
  assert.match(conv("Title {{k}}\n=====\n\nbody\n"), /^# Title \\\{\{k\}\}$/m);
  assert.match(conv("# Use `geml` {{k}}\n\nbody\n"), /^# Use `geml` \\\{\{k\}\} \{#use-geml-k\}$/m);
});

test("a $$ display-math body converts untouched (raw)", () => {
  const g = conv("$$\nx = {{k}}\n$$\n");
  assert.match(g, /^x = \{\{k\}\}$/m);
  assert.doesNotMatch(g, /\\\{\{/);
});

test("a double-backtick md code span keeps {{name}} verbatim", () => {
  const g = conv("The ``a ` {{name}}`` span.\n");
  assert.match(g, /``a ` \{\{name\}\}``/);
  assert.doesNotMatch(g, /\\\{\{/);
});

test("{{name}} in blockquote and footnote bodies converts escaped (flow bodies)", () => {
  const g = conv("> quoted {{v}} here\n\nA claim.[^n]\n\n[^n]: note {{v}} body\n");
  const doc = parse(g);
  assert.equal(doc.diagnostics.filter((d) => d.severity === "error").length, 0);
  assert.match(g, /quoted \\\{\{v\}\} here/);
  assert.match(g, /note \\\{\{v\}\} body/);
});

test("converted Markdown round-trips through the parser cleanly", () => {
  const md = "---\ntitle: T\n---\n\n## H {#h}\n\nText [link](#h) and `code`.\n\n```js\n1\n```\n\n| X | Y |\n|---|---|\n| 1 | 2 |\n";
  const doc = parse(conv(md));
  assert.equal(doc.diagnostics.filter((d) => d.severity === "error").length, 0, JSON.stringify(doc.diagnostics));
});

console.log(`\n${passed} test(s) passed.`);

// --- `geml <file> --to/--from`: the argument paths, which had no tests
//
// The transform entry is the verb an agent reaches for when converting, and its
// refusals were the largest uncovered cluster in the CLI. Each of these is a
// mistake a caller actually makes — a flag with no value, a format that does not
// exist, `--fragment` on an output that has no fragment.

function tRun(args, input) {
  const r = spawnSync(process.execPath, ["dist/geml.js", ...args], { input: input ?? "", encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

test("a flag given without its value is a usage error naming what it wanted", () => {
  for (const [flag, want] of [["--root", /--root needs a directory/], ["--from", /--from needs a format/], ["--to", /--to needs a format/]]) {
    const r = tRun(["-", flag]);
    assert.equal(r.code, 2, `${flag} alone must be exit 2`);
    assert.match(r.err, want);
  }
});

test("an unknown format is refused, and the message lists the ones that exist", () => {
  const from = tRun(["-", "--from", "rtf"], "# H {#h}\n");
  assert.equal(from.code, 2);
  assert.match(from.err, /unknown input format 'rtf'.*geml \| md \| json/s);
  const to = tRun(["-", "--to", "pdf"], "# H {#h}\n");
  assert.equal(to.code, 2);
  assert.match(to.err, /pdf/);
});

test("a leading flag is an unknown COMMAND, not a transform with no file", () => {
  // `geml --to md` never reaches the transform entry: dispatch reads the first
  // word as the verb. Worth pinning, because the message a caller gets here is
  // the one that has to point them somewhere — and because it shows the
  // transform's own "no input file" guard is unreachable from the CLI.
  const r = tRun(["--to", "md"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown command '--to'/);
  assert.match(r.err, /geml --help/);
});

test("--from json reads the document model back in", () => {
  // The round trip a tool takes when it edits the model rather than the text:
  // out to JSON, back from it, and the document survives.
  const doc = "=== meta\ntitle = \"t\"\n===\n\n# H {#h}\n\n=== note {#n}\nbody\n===\n";
  const json = tRun(["-", "--to", "json"], doc);
  assert.equal(json.code, 0, json.err);
  const back = tRun(["-", "--from", "json", "--to", "geml"], json.out);
  assert.equal(back.code, 0, back.err);
  assert.match(back.out, /=== note \{#n\}/);
  assert.match(back.out, /body/);
});

test("--fragment belongs to html, and asking for it elsewhere says so", () => {
  const doc = "# H {#h}\n\ntext\n";
  const ok = tRun(["-", "--to", "html", "--fragment"], doc);
  assert.equal(ok.code, 0, ok.err);
  assert.doesNotMatch(ok.out, /<html|<!doctype/i, "a fragment carries no page shell");
  assert.match(ok.out, /<h1[^>]*>/, "but it does carry the markup");
  const bad = tRun(["-", "--to", "md", "--fragment"], doc);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /fragment/i);
});
