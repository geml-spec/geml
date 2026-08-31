// Hidden blocks/lines (§4), metadata interpolation (§4), and the withdrawal of
// the `output` block type (§3).
// Run with `npm test`.
import { parse } from "../dist/geml.js";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }
const errors = (d) => d.diagnostics.filter((x) => x.severity === "error");

test("`{hidden}` block: flagged, still in the model & referenceable (§4)", () => {
  const d = parse(
    "=== table {#fy25 hidden format=csv header=1 compute=\"FY [%.1f] = Q1 + Q2\"}\nSegment, Q1, Q2\nCloud, 8, 10\n===\n\n" +
    "=== diagram {format=geml-chart data=#fy25 type=bar x=Segment y=FY}\n===",
  );
  const tbl = d.children.find((b) => b.type === "table");
  assert.equal(tbl.hidden, true);
  assert.ok(d.ids.includes("fy25"));            // id still registered
  assert.equal(errors(d).length, 0);            // chart resolves the hidden table
});

test("`{hidden}` on a heading sets the flag", () => {
  const h = parse("# Secret {hidden}").children[0];
  assert.equal(h.hidden, true);
});

test("`%%` line: own hidden node, raw, not reference-checked (§4)", () => {
  const d = parse("%% TODO check [x](#nope)\n\nvisible para");
  const h = d.children.find((b) => b.kind === "hidden");
  assert.equal(h.text, "TODO check [x](#nope)");
  assert.equal(errors(d).length, 0);            // a scratch note cannot break the build
});

test("metadata interpolation `{{key}}` from `=== meta` (§4)", () => {
  const d = parse("=== meta\nproduct = \"Acme\"\nversion = \"1.0-draft\"\n===\n\n# {{product}} manual\n\nFor {{product}} {{version}}.");
  assert.equal(d.children[1].text, "Acme manual");
  assert.equal(d.children[2].text, "For Acme 1.0-draft.");
});

test("an unknown `{{key}}` is a build error (§4)", () => {
  assert.ok(errors(parse("text {{nope}} here")).some((e) => /unknown metadata reference/.test(e.message)));
});

test("`{{key}}` inside a code span is verbatim — no substitution, no error (§4)", () => {
  const d = parse("=== meta\nproduct = \"Acme\"\n===\n\nWrite `{{product}}` to get {{product}}.");
  assert.equal(errors(d).length, 0);
  const p = d.children[1];
  assert.deepEqual(p.inlines.find((n) => n.type === "code"), { type: "code", value: "{{product}}" });
  assert.ok(p.text.endsWith("to get Acme."));       // outside the span it still interpolates
  // an unknown key inside a code span cannot fail the build
  assert.equal(errors(parse("The syntax is `{{key}}`.")).length, 0);
});

test("`{{…}}` inside inline math is verbatim (§4)", () => {
  const d = parse("Let $x_{{n}} = 1$ hold.");
  assert.equal(errors(d).length, 0);
  assert.deepEqual(d.children[0].inlines.find((n) => n.type === "math"), { type: "math", value: "x_{{n}} = 1" });
});

test("`\\{{key}}` escapes interpolation to the literal text `{{key}}` (§4)", () => {
  const d = parse("=== meta\nv = \"1.2\"\n===\n\nType \\{{v}} to reference v.");
  assert.equal(errors(d).length, 0);
  const p = d.children[1];
  assert.equal(p.inlines.map((n) => n.value ?? "").join(""), "Type {{v}} to reference v.");
});

test("an unclosed backtick run is literal text, so interpolation still applies (§4)", () => {
  const d = parse("=== meta\nv = \"1.2\"\n===\n\na ` b {{v}}");
  assert.equal(errors(d).length, 0);
  assert.equal(d.children[1].text, "a ` b 1.2");
});

test("an escaped backtick opens no code span, so interpolation still applies (§4)", () => {
  const d = parse("=== meta\nv = \"1.2\"\n===\n\n\\`{{v}}\\`");
  assert.equal(errors(d).length, 0);
  assert.equal(d.children[1].text, "\\`1.2\\`");
});

test("an invalid key shape `{{9x}}` is literal text and no error (§4)", () => {
  const d = parse("x {{9x}} y");
  assert.equal(errors(d).length, 0);
  assert.equal(d.children[0].text, "x {{9x}} y");
});

test("a self-referential meta value does not re-interpolate (§4)", () => {
  const d = parse('=== meta\nv = "{{v}}"\n===\n\nx {{v}} y');
  assert.equal(errors(d).length, 0);
  assert.equal(d.children[1].text, "x {{v}} y"); // single pass: the injected {{v}} stays literal
});



test("a raw table body never interpolates — cell `{{key}}` is literal, unknown keys included (§4/§6)", () => {
  const d = parse('=== meta\nv = "1.2"\n===\n\n=== table\n| a | {{v}} |\n|---|---|\n| 1 | {{nope}} |\n===');
  assert.equal(errors(d).length, 0);            // {{nope}} in a cell cannot fail the build
  const t = d.children[1].table;
  assert.equal(t.columns[1], "{{v}}");
  assert.equal(t.rows[0][1].text, "{{nope}}");
});

test("an attribute value is never interpolated — `{{key}}` in `caption=` is literal (§4)", () => {
  const d = parse('=== meta\nv = "1.2"\n===\n\n=== note {caption="{{v}}"}\nbody {{v}}\n===');
  assert.equal(errors(d).length, 0);
  assert.equal(d.children[1].attrs.caption, "{{v}}");        // attribute: literal
  assert.equal(d.children[1].children[0].text, "body 1.2");  // flow body: substituted
});

test("`caption` is valid on every typed block, not just tables (§4/§7)", () => {
  for (const src of [
    '=== diagram {format=mermaid caption="Review"}\ngraph LR\n===',
    '=== math {caption="Euler"}\ne^{i\\pi}+1=0\n===',
    '=== code {lang=js caption="Snippet"}\nlet a = 1;\n===',
    '=== note {caption="Aside"}\nx\n===',
  ]) {
    const warned = parse(src).diagnostics.filter((x) => x.code === "unknown-attribute");
    assert.deepEqual(warned, [], `caption accepted: ${src.split("\n")[0]}`);
  }
});

test("a name that is not a NAME warns, because the parse succeeds as something else (§4)", () => {
  const odd = (src) => parse(src).diagnostics.filter((x) => x.code === "name-not-a-name").map((d) => d.message);

  // The case that started this: whitespace splits the attribute object, so the
  // id is `Trade-offs` and `&`/`Laws` become boolean flags. Legal, and not what
  // anyone wrote — the id you then address does not exist.
  const spaced = parse("## H {#Trade-offs & Laws}\n");
  const h = spaced.children[0];
  assert.equal(h.id, "Trade-offs", "the id stops at the first space");
  assert.deepEqual(h.attrs, { "&": true, Laws: true }, "the remainder became flags");
  assert.equal(odd("## H {#Trade-offs & Laws}\n").length, 1, "the `&` flag is named");
  assert.match(odd("## H {#Trade-offs & Laws}\n")[0], /whitespace-separated/, "and says why");

  // Quoting keeps the space (tokenize holds quoted spans) but leaves the quotes
  // IN the id, so it warns too: addressing it means writing them every time.
  assert.match(odd('## H {#"a b"}\n')[0], /id `"a b"`/);

  // Every NAME position is checked, and blocks as well as headings.
  assert.match(odd("=== note {.a/b}\nx\n===\n")[0], /class `a\/b`/);
  assert.match(odd("=== note {#a&b}\nx\n===\n")[0], /id `a&b`/);

  // What the spec allows stays silent — including non-Latin letters (§4: LETTER
  // is any Unicode letter), which is the case a naive ASCII rule would break.
  for (const src of ["## H {#权衡与法则}\n", "## H {#a-b_c9}\n", "=== note {#n .intro hidden}\nx\n===\n"]) {
    assert.deepEqual(odd(src), [], `valid NAMEs stay quiet: ${src.trim()}`);
  }
});

test("a bracketed column name is not mistaken for a `[printf]` format (§6)", () => {
  const d = parse('=== table {format=csv header=1 compute="[Data] = A + B; [Data] [%.1f] = A + B"}\nA,B\n3,4\n===');
  assert.equal(errors(d).length, 0);
  const t = d.children[0].table;
  assert.equal(t.columns[2], "[Data]");        // the name kept its brackets
  assert.equal(t.columns.length, 3);           // the second formula rewrote the same column
  assert.equal(t.rows[0][2].text, "7.0");      // ... and this time with the format applied
});

test("a non-finite compute result holds no value, shows `-`, and warns (§6)", () => {
  const d = parse('=== table {format=csv header=1 compute="c = A / B" summary="c = sum(A) / (sum(B) - sum(B))"}\nA,B\n1,0\n0,0\n===');
  assert.equal(errors(d).length, 0);           // a zero denominator is data, not a broken document
  const t = d.children[0].table;
  assert.equal(t.rows[0][2].text, "-");        // +Infinity
  assert.equal(t.rows[1][2].text, "-");        // NaN (0/0)
  assert.equal(t.rows[0][2].value, undefined); // and nothing downstream can read a number here
  assert.equal(t.summary[2].text, "-");
  const nan = d.diagnostics.filter((x) => x.code === "compute-not-a-number");
  assert.equal(nan.length, 3, "two rows and the summary each say so out loud");
  assert.ok(nan.every((x) => x.severity === "warning"));
});

test("a heading auto-id derives from the raw text before substitution (§4)", () => {
  const d = parse('=== meta\nv = "1.2"\n===\n\n# Release {{v}}');
  assert.equal(errors(d).length, 0);
  assert.equal(d.children[1].id, "release-v"); // anchors do NOT shift when meta changes
});

test("a derived heading id keeps underscores: `foo_bar` and `foobar` stay distinct (§4)", () => {
  const d = parse("# foo_bar\n\n# foobar\n\nsee [[#foo_bar]] and [[#foobar]]");
  assert.equal(errors(d).length, 0, "no duplicate-id, and both auto-refs resolve");
  assert.equal(d.children[0].id, "foo_bar");
  assert.equal(d.children[1].id, "foobar");
});

// §4 makes the heading-id derivation NORMATIVE — six ordered steps — because a
// reference has to name the same block in every implementation. Nothing tested it,
// and three "improvements" to slug() were written and reverted before this suite
// existed. These tests are the spec's own worked examples plus the sharp edges the
// spec accepts on purpose; a change here is a SPEC change, not a parser change.
test("a heading's derived id follows §4's six steps, including its own examples", () => {
  const id = (heading) => parse("# " + heading).children[0].id;

  // The three examples §4 gives verbatim.
  assert.equal(id("Use `foo()` in 2024 Design"), "use-in-2024-design");
  assert.equal(id("Ubytovací zařízení"), "ubytovaci-zarizeni", "step 2 decomposes, step 4 drops the marks");
  assert.equal(id("设计说明"), "设计说明");

  // Step 1 case-folds; step 3 keeps letters, digits, `-` and `_` and drops the
  // rest; steps 4-5 trim whitespace and collapse each run to one `-`.
  assert.equal(id("HELLO   World v2"), "hello-world-v2");
  assert.equal(id("Verify (v2) — final!"), "verify-v2-final");
  assert.equal(id("  spaced   out  "), "spaced-out");
  assert.equal(id("a\tb"), "a-b");
  assert.equal(id("Σοφός"), "σοφος", "the accent goes; the Greek letters stay");

  // §4 spells this one out: derived ids preserve underscores, so these differ.
  assert.equal(id("foo_bar"), "foo_bar");
  assert.equal(id("foobar"), "foobar");
});

// Step 5 replaces runs of WHITESPACE. A literal hyphen is content, so the spaces
// flanking it each become a separator of their own. Collapsing `[\s-]+` instead
// would read better and would also fold `--root` onto `root`, merging two
// headings that §4 keeps distinct — which is why this is pinned rather than tidied.
test("§4: a literal hyphen is content, and whitespace around it still separates", () => {
  const id = (heading) => parse("# " + heading).children[0].id;
  assert.equal(id("A - B"), "a---b");
  assert.equal(id("-foo-"), "-foo-");
  assert.equal(id("--root"), "--root");
  assert.equal(id("root"), "root", "and so `--root` and `root` do not collide");
  assert.equal(id("---"), "---");
});

// Step 2 deletes a code span "its backticks and its content alike", so a heading
// that is ONLY a code span derives the empty id. §4 addresses this directly: such
// an id "is a derived id like any other and therefore collides with a second such
// heading; give either one an explicit `{#id}`". Deriving a name from the code span
// instead — `#geml-dsh-plugin` — also suppresses the duplicate-id error below,
// which is a specified diagnostic, so the empty id is load-bearing.
test("§4: a code-span-only heading derives the empty id, and two of them collide", () => {
  const id = (heading) => parse("# " + heading).children[0].id;
  assert.equal(id("`@geml/dsh-plugin`"), "");
  assert.equal(id("`npm`"), "");
  assert.equal(id("Use `npm` here"), "use-here", "a code span inside prose just vanishes");

  const d = parse("## `npm`\n\na\n\n## `yarn`\n\nb");
  assert.deepEqual([d.children[0].id, d.children[2].id], ["", ""]);
  const dup = d.diagnostics.filter((x) => x.code === "duplicate-id");
  assert.equal(dup.length, 1);
  assert.equal(dup[0].severity, "error");
});

// §4 step 2 normalises to NFD, so every diacritic becomes a combining mark of
// its own and step 4 deletes all of them: a DERIVED id carries no diacritics.
// The point is uniformity. Normalising to NFC instead kept the marks Unicode
// happens to have a precomposed form for (`e` + U+0301 is the letter `é`) and
// dropped the ones it does not (`İ` lower-cases to `i` + U+0307, which no single
// codepoint spells) — the same kind of input with two fates, decided by a lookup
// table rather than by a rule.
test("§4 step 2: a derived id carries no diacritics, uniformly", () => {
  const id = (heading) => parse("# " + heading).children[0].id;

  // Both normalization forms of the same heading converge.
  assert.equal(id("Caf\u00e9"), "cafe", "precomposed");
  assert.equal(id("Cafe\u0301"), "cafe", "decomposed");
  assert.equal(id("Ångström"), "angstrom");
  assert.equal(id("Ångström".normalize("NFD")), "angstrom");

  // The uniformity that NFC did not have: a mark with a precomposed form and one
  // without now share a fate.
  assert.equal(id("İstanbul"), "istanbul");

  // A script that writes no combining marks is untouched — step 4 keeps every
  // Unicode letter, and a diacritic is not one.
  assert.equal(id("设计说明"), "设计说明");
  assert.equal(id("Привет"), "привет");

  // The stated cost: headings differing only in their diacritics derive one id
  // and collide. In Vietnamese, where the marks distinguish words rather than
  // decorate them, that is the normal case — such documents carry explicit ids.
  const d = parse("## má\n\na\n\n## mà\n\nb");
  assert.deepEqual(d.ids, ["ma"]);
  assert.equal(d.diagnostics.filter((x) => x.code === "duplicate-id").length, 1);
  assert.equal(errors(d).length, 1, "loud, and the remedy is an explicit {#id}");
});

// §4: two NAMEs are the same name when equal after NFD. This is the half that
// protects whoever writes the REFERENCE — it applies to explicit ids too, where
// the derivation never runs, and that is where the trap actually bit.
test("§4: an id and a reference match across normalization forms", () => {
  const E = (src) => parse(src).diagnostics.filter((x) => x.severity === "error").map((x) => x.code);
  const NFC = "Caf\u00e9", NFD = "Cafe\u0301";

  assert.deepEqual(E(`# t {#${NFC}}\n\nsee [[#${NFD}]]`), [], "NFC id, NFD reference");
  assert.deepEqual(E(`# t {#${NFD}}\n\nsee [[#${NFC}]]`), [], "NFD id, NFC reference");
  assert.deepEqual(E(`# t {#${NFC}}\n\nsee [^${NFD}]`), [], "and a footnote reference");

  // Explicit ids that differ only in form are one id.
  assert.deepEqual(E(`## a {#${NFC}}\n\np\n\n## b {#${NFD}}\n\nq`), ["duplicate-id"]);

  // But the document's own bytes are never rewritten: §4 requires the id be
  // REPORTED as written, and §0.5 forbids normalizing the character stream.
  const w = parse(`# t {#${NFD}}`);
  assert.equal(w.ids[0], NFD, "reported codepoint-for-codepoint as the document wrote it");
  assert.notEqual(w.ids[0], NFC);
});

// ANTI-DRIFT. §4's derivation is normative, and the way it goes wrong is that
// someone "fixes" slug() without reading §4 — which has happened. So rather than
// restate the spec's worked examples here, pull them OUT of the spec text and run
// them: every `` `<heading>` derives `#<id>` `` sentence in §4 becomes an
// assertion. Editing the parser without the spec fails this, and so does editing
// the spec's examples without the parser. Same device as Appendix A's catalogue
// check in preliminaries.test.mjs.
function derivationsFromSpec(relPath, sectionHeading, verb) {
  const text = readFileSync(join(repoRoot, relPath), "utf8");
  const from = text.indexOf(sectionHeading);
  assert.ok(from >= 0, `${relPath} has ${sectionHeading}`);
  const until = text.indexOf("\n## ", from + sectionHeading.length);
  const section = text.slice(from, until < 0 ? undefined : until).replace(/\s+/g, " ");
  // Inner backticks are written `\`` inside the outer span, so the heading token
  // is "any run of non-backtick or escaped-backtick characters".
  const re = new RegExp("`((?:\\\\`|[^`])+)`\\s*" + verb + "\\s*`#([^`]*)`", "g");
  const out = [];
  for (let m = re.exec(section); m; m = re.exec(section)) {
    out.push([m[1].replace(/\\`/g, "`").replace(/^#{1,6}\s+/, ""), m[2]]);
  }
  return out;
}

for (const [relPath, heading, verb, least] of [
  ["spec/GEML-spec.md", "## 4. Attributes and identifiers", "derives", 5],
  ["spec/GEML-spec_CN.md", "## 4. 属性与标识符", "派生出", 3],
]) {
  test(`${relPath} §4: every worked example in the spec text is what the parser derives`, () => {
    const examples = derivationsFromSpec(relPath, heading, verb);
    // Guard against the regex silently matching nothing and the test passing
    // vacuously — the failure mode of every spec-scraping check.
    assert.ok(examples.length >= least,
      `extracted ${examples.length} examples from ${relPath} §4, expected at least ${least}`);
    for (const [headingText, want] of examples) {
      const got = parse("# " + headingText).children[0].id;
      assert.equal(got, want, `\`## ${headingText}\` should derive \`#${want}\`, got \`#${got}\``);
    }
  });
}

test("across `=== meta` blocks the FIRST definition of a key wins; a redefinition warns (§4)", () => {
  const d = parse('=== meta\nv = "first"\n===\n\n{{v}} {{w}}\n\n=== meta\nv = "second"\nw = "ok"\n===');
  const dup = d.diagnostics.filter((x) => x.code === "duplicate-meta-key");
  assert.equal(dup.length, 1, "one warning for the one redefined key");
  assert.equal(dup[0].severity, "warning");
  assert.match(dup[0].message, /`v` already defined/);
  assert.equal(errors(d).length, 0, "a redefinition never breaks the build");
  // interpolation reads the surviving first value; the new key still lands
  assert.equal(d.children[1].text, "first ok");
});

test("a `=== meta` inside a RAW body is content, never a definition (§3)", () => {
  // A raw body is opaque, so a meta block SHOWN AS AN EXAMPLE inside a longer
  // fence defines nothing. The pre-scan used to be a flat sweep over every
  // line, so example text supplied live `{{key}}` values — and `geml check`
  // reported nothing, because as far as it could tell the key was defined.
  const d = parse('==== code\n=== meta\ntitle = "FROM-EXAMPLE"\n===\n====\n\nValue is {{title}}.');
  assert.equal(d.children[1].text, "Value is {{title}}.", "the example never supplied a value");
  assert.equal(errors(d).length, 1, "and the reference is now correctly unresolved");
  assert.equal(errors(d)[0].code, "unknown-metadata-reference");
});

test("a raw-body example never warns `duplicate-meta-key` against the real definition (§3, §4)", () => {
  // The shape this actually broke: an authoring reference whose `=== meta`
  // example repeats a key the document itself sets. The warning pointed at a
  // redefinition that does not exist, on a document that is entirely valid.
  const d = parse('=== meta\ntitle = "real"\n===\n\n==== code {#ex lang=geml}\n=== meta\ntitle = "Budget plan"\n===\n====\n\n{{title}}');
  assert.deepEqual(d.diagnostics, [], "no diagnostics at all");
  assert.equal(d.children[2].text, "real");
});

test("a `=== meta` nested in a FLOW body still defines metadata (§3)", () => {
  // The other half of the same rule: a flow body IS scanned for nested blocks,
  // so a meta block in one is a real block and its keys are the document's.
  const d = parse('==== note\n=== meta\nv = "nested"\n===\n====\n\n{{v}}');
  assert.equal(errors(d).length, 0);
  assert.equal(d.children[1].text, "nested");
});

test("a `=== meta {#id}` may close on its labeled fence (§3)", () => {
  const d = parse('=== meta {#m}\nv = "1.2"\n=== #m\n\nRelease {{v}}.');
  assert.equal(errors(d).length, 0);
  assert.equal(d.children[1].text, "Release 1.2.");
});

test("a `%%` hidden line is never interpolated (§4)", () => {
  const d = parse("%% scratch {{nope}} note");
  assert.equal(errors(d).length, 0);
  assert.equal(d.children[0].text, "scratch {{nope}} note");
});

test("`=== text` is a registered flow container (§3): flow body, no warning", () => {
  const d = parse("=== text {#p .lead}\nA **bold** claim, see [[#q]].\n===\n\n## Q {#q}");
  assert.equal(d.diagnostics.length, 0, JSON.stringify(d.diagnostics)); // no unknown-type warning
  const t = d.children.find((b) => b.kind === "block" && b.type === "text");
  assert.equal(t.mode, "flow");
  assert.equal(t.id, "p");
  assert.deepEqual(t.classes, ["lead"]);
  const para = (t.children ?? []).find((c) => c.kind === "paragraph");
  assert.ok(para.inlines.some((n) => n.type === "strong"), "**bold** parsed");
  assert.ok(para.inlines.some((n) => n.type === "autoref" && n.anchor === "q"), "[[#q]] parsed");
});

test("a `text` body is reference-checked like any flow block (§8)", () => {
  assert.ok(errors(parse("=== text {#p}\nsee [[#nope]]\n===")).some((e) => /nope/.test(e.message)));
});

test("`=== output` is no longer a block type; it degrades like any unknown type", () => {
  // Withdrawn: a stored-result block earned a type in the registry, a render
  // path, a projection and an `of=#id` reference rule, and nothing used it. An
  // unknown type is not an error — the body is preserved and a warning says the
  // type is unrecognised — so a document that still writes one keeps its content.
  const doc = parse("=== output {of=#load}\nresult\n===");
  const warn = doc.diagnostics.find((d) => d.code === "unknown-block-type");
  assert.ok(warn, `expected unknown-block-type, got ${JSON.stringify(doc.diagnostics.map((d) => d.code))}`);
  assert.equal(warn.severity, "warning", "removing a type must not break existing documents");
  assert.deepEqual(doc.children[0].raw, ["result"], "the body is preserved verbatim");
  // `of=` was only ever checked for this type, so it is now an ordinary attribute.
  assert.equal(errors(parse("=== output {of=#missing}\nx\n===")).length, 0);
});

test("labeled close `=== #id` closes a block regardless of fence length (§3)", () => {
  assert.equal(errors(parse("=== note {#ex}\nbody\n=== #ex")).length, 0);
  // a note can wrap a code block with all length-3 fences, each closed by id
  const d = parse("=== note {#outer}\nExample:\n=== code {#snip lang=python}\nprint(1)\n=== #snip\n=== #outer");
  assert.equal(errors(d).length, 0);
  const note = d.children.find((b) => b.type === "note");
  assert.ok((note.children || []).some((c) => c.type === "code"), "code nested in the note");
});

test("unterminated block names the labeled-close option in its error (§3)", () => {
  assert.ok(errors(parse("=== note {#ex}\nbody")).some((e) => /=== #ex/.test(e.message)));
});

test("a stray labeled fence warns and names the bare close that truncated the block (§3, Appendix A)", () => {
  // The author meant `=== #x` to close the code block, but the equal-length
  // bare `===` inside the body closed it first (§3): everything after line 4
  // fell out of the block, and before this warning `check` said "ok".
  const d = parse("=== code {#x lang=geml}\n=== meta\nt\n===\n=== #x");
  assert.equal(errors(d).length, 0, "a stray labeled fence is a warning, not an error");
  const w = d.diagnostics.filter((x) => x.code === "stray-labeled-fence");
  assert.equal(w.length, 1, JSON.stringify(d.diagnostics));
  assert.equal(w[0].severity, "warning");
  assert.equal(w[0].line, 5);
  assert.ok(/#x/.test(w[0].message) && /bare fence at line 4/.test(w[0].message), w[0].message);
  assert.ok(/truncated/.test(w[0].message), w[0].message);
  // the line itself stays what it always was: paragraph text, model unchanged
  assert.ok(d.children.some((b) => b.kind === "paragraph" && b.text === "=== #x"));
});

test("a labeled-fence line naming no bare-closed block still warns, without a close line (§3)", () => {
  const d = parse("just text\n\n====== #nope");
  const w = d.diagnostics.find((x) => x.code === "stray-labeled-fence");
  assert.ok(w, JSON.stringify(d.diagnostics));
  assert.equal(w.severity, "warning");
  assert.equal(w.line, 3);
  assert.ok(/#nope/.test(w.message) && !/bare fence/.test(w.message), w.message);
});

test("stray-labeled-fence: an id made of regex metacharacters neither crashes nor mismatches", () => {
  const id = "a(b)+[c]*";
  const d = parse(`=== code {#${id}}\nbody\n===\n=== #${id}`);
  const w = d.diagnostics.filter((x) => x.code === "stray-labeled-fence");
  assert.equal(w.length, 1, JSON.stringify(d.diagnostics));
  assert.ok(w[0].message.includes("at line 3"), w[0].message);
});

test("a labeled fence that closes its block is not stray — no warning (§3)", () => {
  const d = parse("=== note {#ok}\nbody\n=== #ok");
  assert.ok(!d.diagnostics.some((x) => x.code === "stray-labeled-fence"));
});

test("a labeled-fence-shaped line inside a raw body is content, never a stray fence (§3)", () => {
  const d = parse("===== code {#doc lang=geml}\n=== note {#n}\nx\n=== #n\n=====");
  assert.ok(!d.diagnostics.some((x) => x.code === "stray-labeled-fence"));
});

test("a stray labeled fence inside a flow body warns, with document line numbers (§3)", () => {
  const d = parse("=== code {#x}\nbody\n===\n\n===== note {#n}\n=== #x\n=====");
  const w = d.diagnostics.find((x) => x.code === "stray-labeled-fence");
  assert.ok(w, JSON.stringify(d.diagnostics));
  assert.equal(w.line, 6);
  assert.ok(/bare fence at line 3/.test(w.message), w.message);
});

test("footnote reference `[^id]` resolves to any block with that id (§5.2)", () => {
  const d = parse("See it.[^n]\n\n=== note {#n}\nThe note text.\n===");
  assert.equal(errors(d).length, 0, JSON.stringify(d.diagnostics));
  assert.ok(d.ids.includes("n"));
  const fn = d.children.find((b) => b.kind === "block" && b.id === "n");
  assert.ok(fn && fn.type === "note");
});

console.log(`\n${passed} test(s) passed.`);
