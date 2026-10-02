// Markdown reading (ParseOptions.markdown): a `.md` is parsed directly — which is
// what keeps a round trip byte-exact — and read the way Markdown reads it at every
// place the two grammars disagree. geml.ts keeps the register; each group below
// pins one entry of it, and each pins the `.geml` side too, which must not move.
//
// Also here: the fixes an outside evaluation of a real Obsidian vault turned up
// that are not Markdown-only — a reference's line number, the write gate every
// verb shares, and the `--in F` message.
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { parse, addressedUnits, blockSpans, unitSpans } from "../dist/geml.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

function run(args, input, cwd) {
  const r = spawnSync(process.execPath, [join(process.cwd(), "dist", "geml.js"), ...args],
    { input, encoding: "utf8", timeout: 60_000, ...(cwd ? { cwd } : {}) });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const dir = mkdtempSync(join(tmpdir(), "geml-md-"));
const write = (rel, s) => {
  const f = join(dir, ...rel.split("/"));
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, s);
  return f;
};
const read = (f) => readFileSync(f, "utf8");
const md = (s) => parse(s, { markdown: true });
const codes = (doc) => doc.diagnostics.map((d) => d.code);

try {
  // -------------------------------------------------------------------------
  // A reference reports the line it is ON (both formats)
  // -------------------------------------------------------------------------

  test("a reference on a paragraph's third line reports line 3, not the paragraph's first", () => {
    const src = "# T\n\none,\ntwo,\nthree [[#nope]].\n";
    for (const doc of [parse(src), md(src)]) {
      const d = doc.diagnostics.find((x) => x.code === "unresolved-reference");
      assert.equal(d.line, 5);
    }
  });

  test("a reference on a list item's continuation line reports that line", () => {
    const d = parse("# T\n\n- first line\n  second [[#nope]]\n").diagnostics.find((x) => x.code === "unresolved-reference");
    assert.equal(d.line, 4);
  });

  test("an unknown {{key}} on a paragraph's second line reports that line", () => {
    const d = parse("# T\n\nfirst\nsecond {{nope}}\n").diagnostics.find((x) => x.code === "unknown-metadata-reference");
    assert.equal(d.line, 4);
  });

  test("a reference inside a link's label reports the label's own line", () => {
    const d = parse("# T\n\nsee [first\nsecond [^x]](https://example.com)\n").diagnostics.find((x) => x.code === "unresolved-footnote");
    assert.equal(d.line, 4);
  });

  // -------------------------------------------------------------------------
  // Repeated headings: GitHub's suffix under Markdown, §4's error under GEML
  // -------------------------------------------------------------------------

  const DUP = "# Note\n\n## 小结\n\none\n\n## 方案\n\ntwo\n\n## 小结\n\nthree\n\n## 小结\n\nfour\n";

  test("repeated headings get GitHub's suffixes, and nothing is a duplicate", () => {
    const doc = md(DUP);
    assert.deepEqual(doc.ids, ["note", "小结", "方案", "小结-1", "小结-2"]);
    assert.deepEqual(codes(doc), []);
  });

  test("a suffix already held by a heading is skipped, as github-slugger skips it", () => {
    assert.deepEqual(md("## a\n\n## a\n\n## a-1\n").ids, ["a", "a-1", "a-1-1"]);
    assert.deepEqual(md("## a\n\n## a-1\n\n## a\n").ids, ["a", "a-1", "a-2"]);
  });

  test("numbered headings: `1.1` and `11` derive one slug, and the second is suffixed", () => {
    // The dot IS deleted — that is §4's rule and GitHub's alike, so the anchors
    // match GitHub's. Only the collision needed fixing.
    assert.deepEqual(md("## 1.1 小节\n\n## 11 小节\n\n## 1.10 小节\n").ids, ["11-小节", "11-小节-1", "110-小节"]);
  });

  test("the parse and every addressing walk agree on a repeated heading's name", () => {
    const parsed = md(DUP).ids;
    const listed = addressedUnits(DUP, { markdown: true }).map((a) => a.unit.id).filter((x) => x !== undefined);
    const spans = [...blockSpans(DUP, { markdown: true }).keys()];
    // unitSpans is the walk the browser bundles (viewer, vscode) address with.
    const browser = unitSpans(DUP, { markdown: true }).map((u) => u.id).filter((x) => x !== undefined);
    assert.deepEqual(listed, parsed);
    assert.deepEqual(spans.sort(), [...parsed].sort());
    assert.deepEqual(browser, parsed);
  });

  test("a .geml keeps §4: two headings deriving one id are duplicate-id", () => {
    assert.ok(codes(parse(DUP)).includes("duplicate-id"));
  });

  test("an explicit duplicate id is still an error under Markdown", () => {
    assert.ok(codes(md("## A {#x}\n\n## B {#x}\n")).includes("duplicate-id"));
  });

  test("the walks default to GEML, so library callers that pass nothing are unchanged", () => {
    assert.equal(addressedUnits(DUP).filter((a) => a.unit.id === "小结").length, 3);
  });

  test("a .md with repeated headings is writable, and each is addressable by its suffix", () => {
    const f = write("dup.md", DUP);
    assert.equal(run(["check", f]).code, 0);
    assert.equal(run(["set", f, "#方案", "--in", "-"], "## 方案\n\nchanged.\n").code, 0, "a unique block");
    const r = run(["set", f, "#小结-1", "--in", "-"], "## 小结\n\nthree, edited.\n");
    assert.equal(r.code, 0, r.err);
    assert.match(read(f), /## 小结\n\nthree, edited\./);
    assert.doesNotMatch(read(f), /\{#/, "the heading carries its id in place, so nothing is stamped");
  });

  test("content without a final newline is judged in place the same way", () => {
    const f = write("dup3.md", DUP);
    const r = run(["set", f, "#小结-1", "--in", "-"], "## 小结\n\nno newline at the end");
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(read(f), /\{#/);
  });

  test("set that changes a repeated heading's text gives it the anchor of its new text", () => {
    // A Markdown heading's anchor is its text, so `## 总结` is `#总结` — no
    // `{#小结-1}` stamped to hold the old one, which GitHub would print.
    const f = write("dup2.md", DUP);
    const r = run(["set", f, "#小结-1", "--in", "-"], "## 总结\n\nrenamed.\n");
    assert.equal(r.code, 0, r.err);
    assert.match(read(f), /^## 总结$/m);
    assert.doesNotMatch(read(f), /\{#/);
    assert.match(r.err, /#小结-1 is now #总结/);
    assert.equal(run(["get", f, "#总结"]).code, 0);
  });

  // -------------------------------------------------------------------------
  // Footnotes are GFM's under Markdown
  // -------------------------------------------------------------------------

  test("a footnote with a `[^label]:` definition is clean, reference and definition alike", () => {
    assert.deepEqual(codes(md("# T\n\nText[^a].\n\n[^a]: the note\n")), []);
  });

  test("a `[^x]` nothing defines is text, so a regex in a sentence is not a reference", () => {
    assert.deepEqual(codes(md("# T\n\nmatch [^0-9] and [^abc] here.\n")), []);
  });

  test("a .geml keeps GEML's footnote: a block with the id, or unresolved-footnote", () => {
    assert.ok(codes(parse("# T\n\nText[^a].\n\n[^a]: the note\n")).includes("unresolved-footnote"));
  });

  // -------------------------------------------------------------------------
  // {{…}} is a template engine's under Markdown
  // -------------------------------------------------------------------------

  test("`{{title}}` in a .md body and frontmatter is text, and reports nothing", () => {
    const doc = md("---\ntitle: \"{{title}}\"\ndate: {{date}}\n---\n\n# {{title}}\n\nOn {{date:YYYY-MM-DD}}.\n");
    assert.deepEqual(codes(doc), []);
    assert.equal(doc.children.find((b) => b.kind === "heading").text, "{{title}}");
  });

  test("a .geml keeps interpolation, and an unknown key is an error", () => {
    const doc = parse("=== meta\ntitle = T\n===\n\n# {{title}} {{nope}}\n");
    assert.equal(doc.children.find((b) => b.kind === "heading").text, "T {{nope}}");
    assert.ok(codes(doc).includes("unknown-metadata-reference"));
  });

  // -------------------------------------------------------------------------
  // Markdown code runs: ~~~, longer fences, indented blocks
  // -------------------------------------------------------------------------

  const FENCES = [
    "# Fences",
    "",
    "prose [[#one]]",
    "",
    "~~~bash",
    "echo '[[#two]]' [^re]",
    "## not a heading",
    "~~~",
    "",
    "````md",
    "```",
    "[[#three]]",
    "```",
    "````",
    "",
    "    indented [[#four]]",
    "    ## nor this",
    "",
    "- item",
    "",
    "    continuation [[#five]]",
    "",
    "~~~",
    "unclosed [[#six]]",
    "",
  ].join("\n");

  test("inside a Markdown code run nothing is a reference; outside one everything still is", () => {
    const refs = md(FENCES).diagnostics.filter((d) => d.code === "unresolved-reference").map((d) => d.message.match(/#(\w+)/)[1]);
    // one: prose. five: four spaces after a list item continue the item.
    // six: an unclosed fence shields nothing, as an unpaired ``` never has.
    assert.deepEqual(refs, ["one", "five", "six"]);
  });

  test("a heading inside a Markdown code run is not addressable", () => {
    const ids = addressedUnits(FENCES, { markdown: true }).filter((a) => a.unit.kind === "heading").map((a) => a.unit.id);
    assert.deepEqual(ids, ["fences"]);
  });

  test("a run is one code span in the model, never inline-parsed", () => {
    const run = md("# T\n\n~~~\na *b* [[#c]]\n~~~\n").children.find((b) => b.kind === "paragraph");
    assert.deepEqual(run.inlines, [{ type: "code", value: "~~~\na *b* [[#c]]\n~~~" }]);
  });

  test("a `=== meta` shown inside a ~~~ fence declares nothing", () => {
    const shown = "# T\n\n~~~\n=== meta\nprofile = \"acme-invoice/v1\"\n===\n~~~\n";
    assert.deepEqual(codes(md(shown)), []);
  });

  test("an indented line in frontmatter is YAML, not code", () => {
    const doc = md("---\ntags:\n\n    - a [[#x]]\n---\n\n# T\n");
    assert.ok(codes(doc).includes("unresolved-reference"), "the frontmatter line was still read");
  });

  test("an indented code block: a tab is four spaces, and the first line may open one", () => {
    assert.deepEqual(codes(md("\tcode [[#a]]\n")), [], "a tab, on line 1");
    assert.deepEqual(codes(md("\n\n    code [[#b]]\n")), [], "after nothing but blank lines");
    assert.deepEqual(codes(md("## H\n    code [[#d]]\n")), [], "straight after a heading: it interrupts no paragraph");
    assert.ok(codes(md("para\n    lazy [[#e]]\n")).includes("unresolved-reference"), "but a paragraph's lazy line is not code");
  });

  test("an empty flow body is scanned like any other", () => {
    const doc = md("# T\n\n=== note {#n}\n===\n");
    assert.ok(doc.ids.includes("n"));
    assert.deepEqual(codes(doc), []);
  });

  test("an unclosed frontmatter opener is a thematic break, not a place to stop looking", () => {
    // Nothing closes the `---`, so there is no frontmatter to skip, and the
    // indented line after the blank one is code.
    assert.deepEqual(codes(md("---\ntitle: x\n\n    code [[#c]]\n")), []);
  });

  test("a .geml keeps GEML's shield: only a ``` pair", () => {
    const refs = parse(FENCES).diagnostics.filter((d) => d.code === "unresolved-reference").length;
    assert.ok(refs > 3, "~~~ and indented blocks are prose to GEML");
  });

  // -------------------------------------------------------------------------
  // Wikilinks
  // -------------------------------------------------------------------------

  write("vault/Target.md", "# Target\n\n## Section\n\nx\n");
  write("vault/deep/folder/Deep Note.md", "# Deep\n");
  write("vault/pic.png", "PNG");
  write("vault/other.geml", "# Other {#top}\n");

  test("Obsidian's link shapes resolve by note name, anywhere under the root", () => {
    const f = write("vault/links.md", [
      "# Links", "",
      "[[Target]] [[Target#Section]] [[Target#Section|shown]] [[target]]", "",
      "![[Target#Section]] ![[pic.png]] [[Target#^abc123]]", "",
      "[[Deep Note]] [[folder/Deep Note]] [[Target.md#Section]]", "",
    ].join("\n"));
    const r = run(["check", f]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /ok: no diagnostics/);
  });

  test("a note not yet written is a warning — both shapes, the same one", () => {
    const f = write("vault/dangling.md", "# D\n\n[[Not Yet]] and [[Not Yet#Part]]\n");
    const r = run(["check", f]);
    assert.equal(r.code, 0, "a warning does not fail check");
    assert.equal((r.err.match(/wikilink `\[\[Not Yet\]\]` names no note/g) ?? []).length, 2, r.err);
  });

  test("a dangling wikilink does not block a write", () => {
    const f = write("vault/dangling2.md", "# D\n\n## A\n\n[[Not Yet]]\n");
    const r = run(["add", f, "--after", "#a", "--in", "-"], "## B\n\n[[Also Not Yet]]\n");
    assert.equal(r.code, 0, r.err);
  });

  test("within the document: a heading by its text, an alias, a block marker", () => {
    const doc = md("# Doc\n\n## Some Title\n\nA line. ^abc123\n\n[[#Some Title]] [[#some-title]] [[#Some Title|t]] [[#^abc123]]\n");
    assert.deepEqual(codes(doc), []);
  });

  test("within the document, a heading that is not there is still an error", () => {
    assert.ok(codes(md("# Doc\n\n[[#Missing Heading]] [[#^nope]]\n")).filter((c) => c === "unresolved-reference").length === 2);
  });

  test("`![[#Section]]` in a .md is an Obsidian embed, not a GEML inline projection", () => {
    assert.deepEqual(codes(md("# Doc\n\n## Part\n\n![[#Part]]\n")), []);
  });

  test("a `.geml` target in a .md keeps GEML's check of its id", () => {
    const f = write("vault/to-geml.md", "# X\n\n[[other.geml#top]] [[other.geml#nope]]\n");
    const r = run(["check", f]);
    assert.equal(r.code, 1);
    assert.match(r.err, /other\.geml#nope/);
    assert.doesNotMatch(r.err, /other\.geml#top/);
    const whole = run(["check", write("vault/to-geml2.md", "# X\n\n[[other.geml]] [[gone.geml]]\n")]);
    assert.match(whole.err, /cannot resolve document `gone\.geml`/);
    assert.doesNotMatch(whole.err, /`other\.geml`/, "a whole-document link to one that exists is clean");
  });

  test("with no host to ask, a wikilink to another note is not checked", () => {
    assert.deepEqual(codes(md("# Doc\n\n[[Anything At All]]\n")), []);
  });

  test("a .geml reads `[[Target#Section]]` as GEML: a document named `Target`", () => {
    const f = write("vault/as-geml.geml", "# X\n\n[[Target#Section]]\n");
    assert.match(run(["check", f]).err, /cannot resolve document `Target`/);
  });

  test("below an Obsidian vault root, check says where the root is", () => {
    write("vault2/.obsidian/app.json", "{}");
    write("vault2/b/B Note.md", "# B\n");
    const f = write("vault2/a/A.md", "# A\n\n[[B Note]]\n");
    const r = run(["check", "A.md"], undefined, join(dir, "vault2", "a"));
    assert.match(r.err, /names no note/);
    assert.match(r.err, /note: A\.md is in the Obsidian vault at \.\.; --root \.\. resolves/);
    const rooted = run(["check", f, "--root", join(dir, "vault2")]);
    assert.match(rooted.err, /ok: no diagnostics/);
    // From the vault root itself the hint is `--root .`; a path with a space is quoted.
    assert.match(run(["check", join("a", "A.md")], undefined, join(dir, "vault2")).err, /--root \. resolves/);
    write("my vault/.obsidian/app.json", "{}");
    write("my vault/b/Other.md", "# O\n");
    write("my vault/a/A.md", "# A\n\n[[Other]]\n");
    assert.match(run(["check", join("my vault", "a", "A.md")], undefined, dir).err, /--root "my vault" resolves/);
  });

  // -------------------------------------------------------------------------
  // One write gate for every verb
  // -------------------------------------------------------------------------

  const OLD_DEFECT = "# Doc\n\n## A {#a}\n\nSee [[#gone]].\n\n## B\n\nb\n";

  test("add into a .md carrying an old defect elsewhere is written", () => {
    const f = write("gate-add.md", OLD_DEFECT);
    const r = run(["add", f, "--after", "#b", "--in", "-"], "## C\n\nc\n");
    assert.equal(r.code, 0, r.err);
  });

  test("add that introduces a defect is still refused, and says it did", () => {
    const f = write("gate-add2.md", OLD_DEFECT);
    const r = run(["add", f, "--after", "#b", "--in", "-"], "## C\n\n[[#also-gone]]\n");
    assert.equal(r.code, 1);
    assert.match(r.err, /adding the content would break the document: unresolved reference `#also-gone`/);
  });

  test("rename in a .md carrying an old defect elsewhere is written", () => {
    const f = write("gate-rename.md", OLD_DEFECT);
    const r = run(["rename", f, "#a", "#a2"]);
    assert.equal(r.code, 0, r.err);
  });

  test("in a .geml nothing is forgiven, and the refusal blames the old defect, not the edit", () => {
    const f = write("gate.geml", OLD_DEFECT);
    const r = run(["add", f, "--after", "#b", "--in", "-"], "## C\n\nc\n");
    assert.equal(r.code, 1);
    assert.match(r.err, /refused by an error the document ALREADY had/);
  });

  test("a refusal on an old defect names its line in the file on disk, not in the rejected candidate", () => {
    // The replacement is one line shorter (no trailing blank), so the defect sits
    // a line higher in the candidate than in the file the reader opens.
    const doc = "# 预算 {#budget}\n\n托管费每月 120 元。\n\n# 附录 {#appendix}\n\n见 [[#budjet]]。\n";
    const f = write("gate-lines.geml", doc);
    assert.match(run(["check", f]).err, /unresolved reference `#budjet` \(line 7\)/);
    const shorter = run(["set", f, "#budget", "--in", "-"], "# 预算 {#budget}\n\n托管费每月 150 元。");
    assert.equal(shorter.code, 1);
    assert.match(shorter.err, /ALREADY had.*unresolved reference `#budjet` \(line 7\)/);
    const frame = JSON.parse(run(["set", f, "#budget", "--json", "--in", "-"], "# 预算 {#budget}\n\n托管费每月 150 元。").err.trim().split(/\r?\n/).pop());
    assert.deepEqual(frame.diagnostics.map((d) => [d.code, d.line]), [["unresolved-reference", 7]], "the --json frame uses the same numbering");
    // Longer, the other way: three lines more in the candidate, still line 7 on disk.
    const longer = run(["set", f, "#budget", "--in", "-"], "# 预算 {#budget}\n\n托管费每月 150 元。\n\n含备份。\n\n含监控。\n");
    assert.match(longer.err, /unresolved reference `#budjet` \(line 7\)/);
    assert.equal(readFileSync(f, "utf8"), doc, "nothing was written");
  });

  test("two copies of one old defect keep their own on-disk lines, and a warning is nobody's twin", () => {
    const doc = "# 预算 {#budget}\n\n托管费每月 120 元。\n\n=== note {#n oops=1}\nx\n===\n\n# 附录 {#appendix}\n\n见 [[#budjet]]。\n\n又见 [[#budjet]]。\n";
    const f = write("gate-twins.geml", doc);
    const disk = JSON.parse(run(["check", f, "--json"]).out).filter((d) => d.severity === "error").map((d) => d.line);
    assert.deepEqual(disk, [11, 13]);
    const r = run(["set", f, "#budget", "--json", "--in", "-"], "# 预算 {#budget}\n\n托管费每月 150 元。");
    assert.equal(r.code, 1);
    const frame = JSON.parse(r.err.trim().split(/\r?\n/).pop());
    assert.deepEqual(frame.diagnostics.map((d) => d.line), disk, "each copy pairs with its own twin, in order");
  });

  test("delete reports only what it left dangling", () => {
    const f = write("gate-del.md", "# Doc\n\nOld [[#gone]].\n\n## A {#a}\n\na\n\n## B\n\n[[#a]]\n");
    const r = run(["delete", f, "#a"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /`#a`.*left dangling by delete/);
    assert.doesNotMatch(r.err, /`#gone`.*left dangling/, "an old defect is not the delete's");
  });

  // -------------------------------------------------------------------------
  // `--in F` says what it reads
  // -------------------------------------------------------------------------

  test("--in F naming a file without that block says which channel writes F's text", () => {
    const f = write("in.md", "# D\n\n## A\n\nx\n");
    const raw = write("raw.txt", "plain text\n");
    const r = run(["set", f, "#a", "--body", "--in", raw]);
    assert.equal(r.code, 1);
    assert.match(r.err, /no block with id `a` in .*raw\.txt — `--in F` takes the block of that id FROM F; to write F's text as the content, use `--in - </);
  });

  // -------------------------------------------------------------------------
  // HTML anchors are link targets, as on GitHub
  // -------------------------------------------------------------------------

  test("a link to an <a id> or <a name> anchor resolves; a link to no anchor still fails", () => {
    // This repo's own README anchors its contents table this way, and GitHub
    // follows every one of those links — so `check` calling them broken was a
    // wrong answer, not a strict one.
    const doc = md(
      "# Doc\n\n- [Why now](#why-now) · [Old](#old-style) · [Upper](#Mixed-Case) · [Nope](#nope)\n\n" +
      '<a id="why-now"></a>\n## Why GEML, and why now\n\n' +
      "text <a name='old-style'></a> more\n\n" +
      '<A HREF="#x" ID=Mixed-Case>jump</A>\n',
    );
    const errs = doc.diagnostics.filter((d) => d.severity === "error");
    assert.deepEqual(errs.map((d) => d.message), ["unresolved reference `#nope`"]);
  });

  test("a <span id> is an anchor too; a <span name>, and any other element's id, is not", () => {
    // MinerU marks a page footnote `<span id="note-one">` and links it as
    // `[\[1\]](#note-one)`. The rule stops at <a> and <span> on purpose: GitHub
    // keeps an id on more elements than that, but each one added is a case to
    // get right, and these two are the ones real documents anchor with.
    const doc = md(
      "# Doc\n\n[a](#fn) [b](#span-name) [c](#div-id) [d](#sup-id)\n\n" +
      '<small><span id="fn" class="docvortex-page-footnote">Body.</span></small>\n\n' +
      '<span name="span-name">x</span> <div id="div-id">y</div> <sup id="sup-id">2</sup>\n',
    );
    const missing = doc.diagnostics.filter((d) => d.code === "unresolved-reference").map((d) => d.message);
    assert.deepEqual(missing, [
      "unresolved reference `#span-name`", "unresolved reference `#div-id`", "unresolved reference `#sup-id`",
    ]);
  });

  test("an anchor inside code, a code span or a comment is text, not a target", () => {
    const doc = md(
      "# Doc\n\n[a](#in-fence) [b](#in-span) [c](#in-comment) [d](#in-block-comment) [e](#data-attr)\n\n" +
      '```html\n<a id="in-fence"></a>\n```\n\n' +
      'Write `<a id="in-span"></a>` to make one.\n\n' +
      '<!-- <a id="in-comment"></a> -->\n\n' +
      '<!--\n<a id="in-block-comment"></a>\n-->\n\n' +
      '<a data-id="data-attr" title="id=data-attr"></a>\n',
    );
    const missing = doc.diagnostics.filter((d) => d.code === "unresolved-reference").map((d) => d.message);
    assert.deepEqual(missing, [
      "unresolved reference `#in-fence`", "unresolved reference `#in-span`",
      "unresolved reference `#in-comment`", "unresolved reference `#in-block-comment`",
      "unresolved reference `#data-attr`",
    ]);
  });

  test("an anchor is a link target only: it is not an address, and a .geml reads it as text", () => {
    const src = "# Doc\n\n[x](#why-now)\n\n<a id=\"why-now\"></a>\n\n## Section\n\nbody\n";
    assert.ok(!md(src).ids.includes("why-now"), "not a block id `get` could address");
    const f = write("anchor-addr.md", src);
    assert.equal(run(["get", f, "#why-now"]).code, 1, "and `get` finds nothing there");
    // GEML has no raw HTML, so in a .geml the same text is prose and the link is broken.
    const geml = parse(src);
    assert.ok(geml.diagnostics.some((d) => d.code === "unresolved-reference"));
  });

  test("a link to GitHub's anchor for a heading resolves, beside the heading's own id", () => {
    // §4's derivation and github-slugger part ways on code spans, whitespace
    // runs and diacritics. A README's contents table is written against GitHub,
    // so each of these links works there — and each was reported broken.
    const doc = md(
      "# Doc\n\n" +
      "[a](#c--rust) [b](#geml-get-in-5-minutes) [c](#café) [d](#see-the-docs-old-new) [e](#renamed-alpha) [f](#q--a)\n\n" +
      "[g](#c-rust) [h](#in-5-minutes) [i](#cafe) [j](#alpha) [k](#nope)\n\n" +
      "## C++ & Rust\n\n## `geml get` in 5 minutes\n\n## Café\n\n" +
      "## See [the docs](https://example.com) ~~old~~ **new**\n\n## Renamed {#alpha}\n\n## Q & A ##\n",
    );
    const missing = doc.diagnostics.filter((d) => d.code === "unresolved-reference").map((d) => d.message);
    assert.deepEqual(missing, ["unresolved reference `#nope`"], "GitHub's anchors and GEML's ids both resolve; nothing else does");
  });

  test("GitHub's anchor on the edges, as GitHub's own renderer gives it", () => {
    // Each expected anchor is what GitHub's Markdown API (mode=markdown, the one
    // a README renders with) returned for the heading on 2026-09-30. Chosen where
    // GitHub's anchor and §4's id differ, so only GitHub's rule can resolve it:
    // a trailing `\` leaves no trace (GEML's §4 fold takes it before the text is
    // read; GitHub's slug deletes it); a closing `##` is not text; `C#` keeps its
    // `#` up to the slug; a tag nested in a tag leaves no markup, and a bare
    // `<` or `>` is punctuation; and a heading with no letter or digit gets no
    // anchor.
    const cases = [
      ["C++ & Rust\\", "c--rust"],
      ["C++ & Rust ##", "c--rust"],
      ["C++ & C#", "c--c"],
      ["a <scr<b>ipt> b", "a-script-b"],
      ["1 < 2 > 0 x", "1--2--0-x"],
    ];
    for (const [heading, anchor] of cases) {
      const errs = md(`# Doc\n\n[x](#${anchor})\n\n## ${heading}\n`).diagnostics.filter((d) => d.code === "unresolved-reference");
      assert.deepEqual(errs, [], `## ${heading} → #${anchor}`);
    }
    for (const bare of ["!!!", "###"]) {
      assert.deepEqual(codes(md(`# Doc\n\n## ${bare}\n`)), [], `## ${bare} registers nothing and breaks nothing`);
    }
  });

  test("an <a id> beside an escaped backtick, an unclosed one, or a bare attribute is still an anchor", () => {
    // GitHub keeps all three (checked against its renderer): `\`` is a literal
    // backtick, an unclosed run is literal text, and `hidden` takes no value.
    const doc = md(
      "# Doc\n\n[a](#esc) [b](#open) [c](#bare)\n\n" +
      '\\`x <a id="esc"></a>\n\n`unclosed <a id="open"></a>\n\n<a hidden id="bare"></a>\n',
    );
    assert.deepEqual(doc.diagnostics.filter((d) => d.code === "unresolved-reference"), []);
  });

  test("a repeated heading's GitHub anchor takes github-slugger's -N", () => {
    const doc = md("# Doc\n\n[a](#c--rust-1) [b](#c--rust-2)\n\n## C++ & Rust\n\n## C++ & Rust\n");
    const missing = doc.diagnostics.filter((d) => d.code === "unresolved-reference").map((d) => d.message);
    assert.deepEqual(missing, ["unresolved reference `#c--rust-2`"], "two headings: -1 exists, -2 does not");
  });

  test("GitHub's anchor is a link target only: the address is still the heading's id, and a .geml is unaffected", () => {
    const src = "# Doc\n\n[x](#c--rust)\n\n## C++ & Rust\n\nbody\n";
    const f = write("gh-anchor.md", src);
    assert.equal(run(["get", f, "#c--rust"]).code, 1, "not an address");
    assert.equal(run(["get", f, "#c-rust"]).code, 0, "the address is unchanged");
    const geml = parse(src);
    assert.ok(geml.diagnostics.some((d) => d.code === "unresolved-reference"), "a .geml reads §4's id only");
  });

  test("check and the write gate agree: a .md whose links point at anchors checks clean and takes a write", () => {
    const f = write("anchors.md", '# Doc\n\n[Jump](#later)\n\n<a id="later"></a>\n\n## A\n\na\n\n## B\n\nb\n');
    const c = run(["check", f]);
    assert.equal(c.code, 0, c.err);
    const s = run(["set", f, "#a", "--body", "--in", "-"], "see [Jump](#later) again\n");
    assert.equal(s.code, 0, s.err);
    const bad = run(["set", f, "#b", "--body", "--in", "-"], "see [Gone](#not-an-anchor)\n");
    assert.equal(bad.code, 1);
    assert.match(bad.err, /unresolved reference `#not-an-anchor`/);
  });
  // -------------------------------------------------------------------------
  // A real producer: MinerU's Markdown
  // -------------------------------------------------------------------------
  // test/fixtures/mineru-output.md is assembled from the EXPECTED outputs in
  // DocVortex's tests/unittest/test_markdown_render.py — the renderer behind
  // MinerU (opendatalab/MinerU), which turns PDFs into Markdown for agents. Each
  // part is a string that renderer is pinned to produce: a contents link to an
  // `<a id>` anchor, a page footnote linked to a `<span id>`, `$$` and `\[…\]`
  // formulas, a GFM table with `A\|B` and a formula in a cell, a complex table
  // left as `<table>`, fences of four backticks around three, a table inside
  // `<details>`, the `\-` and `\---` it escapes, and a base64 image.

  const MINERU = readFileSync(join(process.cwd(), "test", "fixtures", "mineru-output.md"), "utf8");

  test("MinerU's Markdown checks clean: every construct it emits reads as Markdown", () => {
    const f = write("mineru.md", MINERU);
    const r = run(["check", f]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /ok: no diagnostics/);
  });

  test("MinerU's Markdown round-trips byte for byte, unit by unit", () => {
    const f = write("mineru-rt.md", MINERU);
    const addresses = JSON.parse(run(["list", f, "--json"]).out).map((b) => b.address);
    assert.ok(addresses.length >= 2, addresses.join(" "));
    for (const a of addresses) {
      const got = run(["get", f, a]);
      assert.equal(got.code, 0, got.err);
      assert.equal(run(["set", f, a, "--in", "-"], got.out).code, 0, a);
      assert.equal(read(f), MINERU, `${a} came back unchanged`);
    }
  });

  test("a footnote added the way MinerU writes one is accepted", () => {
    const f = write("mineru-add.md", MINERU);
    const r = run(["add", f, "--append", "--in", "-"],
      '## Added\n\nAlso see [\\[2\\]](#note-two).\n\n<small><span id="note-two">Second.</span></small>\n');
    assert.equal(r.code, 0, r.err);
    assert.equal(run(["check", f]).code, 0);
  });

  test("MinerU's Markdown converts: $$ to math, pipe tables to tables, every fence to code", () => {
    const f = write("mineru-conv.md", MINERU);
    const r = run([f, "--to", "geml"]);
    assert.equal(r.code, 0, r.err);
    const kinds = [...r.out.matchAll(/^=+ (\w+)/gm)].map((m) => m[1]);
    assert.deepEqual(kinds.filter((k) => k === "math").length, 1, "the $$ block; \\[…\\] is not recognized yet");
    assert.deepEqual(kinds.filter((k) => k === "table").length, 2, "the pipe table and the one inside <details>");
    assert.deepEqual(kinds.filter((k) => k === "code").length, 3, "```` around ```, ````python and ```txt");
    assert.match(r.out, /=== code \{#code-2 lang=python\}/);
  });


  // -------------------------------------------------------------------------
  // A Markdown heading's anchor is its text
  // -------------------------------------------------------------------------

  const RENAMABLE =
    "# Doc\n\nSee [the risks](#risks), [again](#risks \"why\") and [other](#risks-x).\n\n[r]: #risks\n\n" +
    "Code `[x](#risks)` stays.\n\n```md\n[in a fence](#risks)\n```\n\n" +
    "## Risks\n\nbody\n\n## Risks x\n\nother\n\n## Install\n\nsteps\n";

  test("set --head on a Markdown heading gives it the anchor its new text derives, and its links follow", () => {
    const f = write("rename-head.md", RENAMABLE);
    const r = run(["set", f, "#risks", "--head", "--in", "-", "-o", f], "## Hazards\n");
    assert.equal(r.code, 0, r.err);
    const after = read(f);
    assert.match(after, /^## Hazards$/m, "the heading is plain Markdown");
    assert.doesNotMatch(after, /\{#/, "no GEML attribute object anywhere");
    assert.match(after, /\[the risks\]\(#hazards\)/);
    assert.match(after, /\[again\]\(#hazards "why"\)/, "a link with a title follows too");
    assert.match(after, /^\[r\]: #hazards$/m, "a reference definition follows");
    assert.match(after, /\[other\]\(#risks-x\)/, "another anchor sharing the prefix is left alone");
    assert.match(after, /`\[x\]\(#risks\)`/, "a code span is not a link");
    assert.match(after, /\[in a fence\]\(#risks\)/, "a fenced block is not a link");
    assert.match(r.err, /#risks is now #hazards: a Markdown heading's anchor is its text; 3 links to it updated/);
    assert.equal(run(["get", f, "#hazards"]).code, 0, "the new address reads");
    assert.equal(run(["check", f]).code, 0, "and the document is clean");
  });

  test("a whole-section set that renames a Markdown heading follows the same rule", () => {
    const f = write("rename-whole.md", RENAMABLE);
    const r = run(["set", f, "#risks", "--in", "-", "-o", f], "## Hazards\n\nnew body\n");
    assert.equal(r.code, 0, r.err);
    assert.match(read(f), /^## Hazards$/m);
    assert.match(read(f), /\[the risks\]\(#hazards\)/);
  });

  test("renamed to the text of another heading, a Markdown heading takes GitHub's -1 and its links follow", () => {
    const f = write("rename-dup.md", RENAMABLE);
    const r = run(["set", f, "#risks", "--head", "--in", "-", "-o", f], "## Install\n");
    assert.equal(r.code, 0, r.err);
    assert.match(read(f), /\[the risks\]\(#install\)/, "the first `## Install` is now this one, as on GitHub");
    assert.equal(run(["check", f]).code, 0, run(["check", f]).err);
  });

  test("a Markdown heading that declares its id keeps it, as in GEML", () => {
    const f = write("rename-declared.md", "# Doc\n\nSee [r](#risks).\n\n## Risks {#risks}\n\nbody\n");
    assert.equal(run(["set", f, "#risks", "--head", "--in", "-", "-o", f], "## Hazards\n").code, 0);
    assert.match(read(f), /^## Hazards \{#risks\}$/m, "the declared id stays");
    assert.match(read(f), /\[r\]\(#risks\)/);
  });

  test("rename refuses a Markdown heading's derived id and says how to rename it", () => {
    const f = write("rename-verb.md", RENAMABLE);
    const before = read(f);
    const r = run(["rename", f, "#risks", "#hazards"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /in Markdown a heading's anchor is its text, so `#risks` cannot be renamed apart from it — change the heading's text instead \(geml set <file> '#risks' --head\)/);
    assert.equal(read(f), before, "nothing written");
    const g = write("rename-verb-declared.md", "# Doc\n\nSee [r](#risks).\n\n## Risks {#risks}\n\nbody\n");
    assert.equal(run(["rename", g, "#risks", "#hazards"]).code, 0, "a declared id renames as in GEML");
    assert.match(read(g), /\[r\]\(#hazards\)/);
  });

  test("in a .geml a renamed heading keeps its address and rename works as before", () => {
    const f = write("rename-unchanged.geml", "# Doc {#top}\n\nSee [[#risks]].\n\n## Risks\n\nbody\n");
    assert.equal(run(["set", f, "#risks", "--head", "--in", "-", "-o", f], "## Hazards\n").code, 0);
    assert.match(read(f), /^## Hazards \{#risks\}$/m);
    // rename on a .geml heading answers as it always has: a derived id is refused
    // by the reference check (not with the Markdown message), a declared one renames.
    const g = write("rename-unchanged-2.geml", "# Doc {#top}\n\nSee [[#risks]].\n\n## Risks\n\nbody\n");
    const derived = run(["rename", g, "#risks", "#hazards"]);
    assert.equal(derived.code, 1);
    assert.match(derived.err, /rename would break the document: unresolved reference `#hazards`/);
    assert.doesNotMatch(derived.err, /in Markdown/);
    const h = write("rename-unchanged-3.geml", "# Doc {#top}\n\nSee [[#risks]].\n\n## Risks {#risks}\n\nbody\n");
    assert.equal(run(["rename", h, "#risks", "#hazards"]).code, 0);
    assert.match(read(h), /\[\[#hazards\]\]/);
    assert.match(read(h), /^## Risks \{#hazards\}$/m);
  });

  // -------------------------------------------------------------------------
  // A link title is a title
  // -------------------------------------------------------------------------

  test("a Markdown link's title and <…> destination are not part of its target; a .geml reads them as before", () => {
    const doc = md('# Doc\n\n[a](#doc "Title") [b](#doc \'t\') [c](#doc (t)) [d](<#doc>) [e](#nope "Title")\n');
    assert.deepEqual(doc.diagnostics.filter((d) => d.code === "unresolved-reference").map((d) => d.message),
      ["unresolved reference `#nope`"]);
    const geml = parse('# Doc {#doc}\n\n[a](#doc "Title")\n');
    assert.ok(geml.diagnostics.some((d) => d.message === 'unresolved reference `#doc "Title"`'), "GEML has no link titles");
  });

  // -------------------------------------------------------------------------
  // GEML content written into a .md lands as Markdown
  // -------------------------------------------------------------------------

  test("GEML content added to a .md is converted to Markdown, and the write says so", () => {
    const f = write("conv-add.md", "# Doc\n\n## A\n\nbody\n");
    const r = run(["add", f, "--after", "#a", "--in", "-"], "=== note {#tip}\nA *tip*.\n===\n");
    assert.equal(r.code, 0, r.err);
    assert.match(read(f), /^> A \*tip\*\.$/m, "a note is a blockquote");
    assert.doesNotMatch(read(f), /===|\{#/, "no GEML syntax lands");
    assert.match(r.err, /the content was GEML and was converted to Markdown, as --to md converts it/);
  });

  test("a GEML body set into a .md section converts block by block, keeping the blank lines around it", () => {
    const f = write("conv-body.md", "# Doc\n\n## Risks\n\nbody\n\n## Notes\n\nn\n");
    const r = run(["set", f, "#risks", "--body", "--in", "-"],
      "\nCosts:\n\n=== table {#c format=csv header=1}\nItem, Q1\nCloud, 8\n===\n\n=== code {lang=py}\nx = 1\n===\n\n");
    assert.equal(r.code, 0, r.err);
    assert.equal(read(f),
      "# Doc\n\n## Risks\n\nCosts:\n\n| Item | Q1 |\n| --- | --- |\n| Cloud | 8 |\n\n```py\nx = 1\n```\n\n## Notes\n\nn\n");
  });

  test("Markdown content lands verbatim, Obsidian and template syntax included", () => {
    const f = write("conv-verbatim.md", "# Doc\n\n## Notes\n\nn\n");
    const body = "See [[#Notes]], {{title}} and `=== code` in a span.\n\n%% an Obsidian comment %%\n\n```\n=== not a fence here\n```\n";
    const r = run(["set", f, "#notes", "--body", "--in", "-"], body);
    assert.equal(r.code, 0, r.err);
    assert.ok(read(f).includes(body), "byte for byte");
    assert.doesNotMatch(r.err, /converted/);
  });

  test("a view whose source is not in the content is refused, not written empty", () => {
    const f = write("conv-view.md", "# Doc\n\n## A\n\nbody\n");
    const before = read(f);
    const r = run(["add", f, "--after", "#a", "--in", "-"], '=== view {#v src=#t compute="x = a"}\n===\n');
    assert.equal(r.code, 1);
    assert.match(r.err, /converting it to Markdown for .*conv-view\.md would lose data \(table from external source `#t` could not be read/);
    assert.equal(read(f), before);
  });

  test("a GEML block already in a .md is left to GEML, and a .geml is not converted at all", () => {
    const f = write("conv-kept.md", "# Doc\n\n## Notes\n\n=== note {#kept}\nold\n===\n");
    assert.equal(run(["set", f, "#kept", "--in", "-"], "=== note {#kept}\nnew\n===\n").code, 0);
    assert.match(read(f), /=== note \{#kept\}\nnew\n===/);
    const g = write("conv-control.geml", "# D {#top}\n\n## A {#a}\n\nalpha\n");
    const r = run(["add", g, "--after", "#a", "--in", "-"], "=== note {#tip}\nA *tip*.\n===\n");
    assert.equal(r.code, 0, r.err);
    assert.match(read(g), /=== note \{#tip\}\nA \*tip\*\.\n===/);
    assert.doesNotMatch(r.err, /converted/);
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nmarkdown-mode: ${passed} passed`);
