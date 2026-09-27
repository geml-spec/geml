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

  test("set that changes a repeated heading's text still keeps its address", () => {
    const f = write("dup2.md", DUP);
    assert.equal(run(["set", f, "#小结-1", "--in", "-"], "## 总结\n\nrenamed.\n").code, 0);
    assert.match(read(f), /## 总结 \{#小结-1\}/);
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
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nmarkdown-mode: ${passed} passed`);
