// GEP 0010 — a translated document as a PROJECTION along the language axis.
//
// Three things are under test and they are separable on purpose:
//   1. prose runs get addresses (span layer, no specification change);
//   2. a reference — in this document or another — resolves one (normative);
//   3. what a translation may and may not touch.
//
// The addresses in (1) are not invented here: the proposal publishes a worked
// example with its `geml list` output, and this suite reproduces that document so
// the implementation is checked against the document that specified it.
import { parse, addressedUnits, proseRunTargets, translateBlocks, translateInlines, glossaryFrom, gemlToMd, selectEmbed, resolveTarget } from "../dist/geml.js";
import { shortestAddress } from "../dist/selector.js";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }
const errors = (d) => d.diagnostics.filter((x) => x.severity === "error");
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The proposal's worked example, verbatim in shape.
const PUB = `=== meta
title = "Publishing"
===

# Publishing {#pub}

Cut the release from a clean tree.

=== code {#cmd lang=sh}
npm publish
===

Then confirm it landed.

## Verify {#verify}

Check each artifact.

=== table {#checks format=csv header=1}
artifact, where
parser, npm
===

Anything red, stop.
`;

test("§GEP-0010: the four run shapes are exactly the proposal's worked example", () => {
  const listed = addressedUnits(PUB).map((a) => [shortestAddress(a, addressedUnits(PUB)), a.unit.kind]);
  assert.deepEqual(listed, [
    ["=== meta", "block"],
    ["#pub", "heading"],
    ["#pub-before-cmd", "prose"],          // P absent -> #C-before-N
    ["#cmd", "block"],
    ["#cmd-between-verify", "prose"],      // both present -> #P-between-N
    ["#verify", "heading"],
    ["#verify-before-checks", "prose"],
    ["#checks", "block"],
    ["#verify-after-checks", "prose"],     // N absent -> #C-after-P
  ]);
});

// The relation word is DETERMINED by structure, so each shape has exactly one
// spelling and no convention has to be agreed on top of the rule.
// ANTI-DRIFT, the device preliminaries.test.mjs uses for Appendix A and
// features.test.mjs uses for §4's derivations: the rule is scraped OUT of the
// specification rather than restated here, so editing §4's table without editing
// the parser fails, and so does the reverse.
test("§4: the three address forms are the ones the specification tabulates", () => {
  const spec = readFileSync(join(repoRoot, "spec", "GEML-spec.md"), "utf8");
  const from = spec.indexOf("**Prose between two blocks has an address");
  assert.ok(from >= 0, "§4 carries the prose-run derivation");
  const table = spec.slice(from, spec.indexOf("Three rules complete it", from));
  const forms = [...table.matchAll(/`([A-Z]-(?:between|before|after)-[A-Z])`/g)].map((m) => m[1]);
  assert.deepEqual(forms, ["P-between-N", "C-before-N", "C-after-P"],
    `scraped ${forms.length} forms from §4's table`);

  // And the parser produces one address of each shape, in the case the table
  // assigns it: `before` opens a container, `between` sits among siblings,
  // `after` closes one.
  const got = addressedUnits(PUB).filter((a) => a.unit.kind === "prose").map((a) => a.unit.id);
  assert.deepEqual(got, ["pub-before-cmd", "cmd-between-verify", "verify-before-checks", "verify-after-checks"]);
});

test("§GEP-0010: a run spans every non-anchor block between two anchors", () => {
  const src = "# Sec {#sec}\n\nFirst.\n\nSecond.\n\n- one\n- two\n\n=== code {#c lang=sh}\nx\n===\n";
  const runs = proseRunTargets(parse(src).children);
  const run = runs.get("sec-before-c");
  assert.ok(run !== undefined, `expected #sec-before-c, got ${[...runs.keys()].join(", ")}`);
  assert.deepEqual(run.map((b) => b.kind), ["paragraph", "paragraph", "list"],
    "a run is not one paragraph — it is everything between the anchors");
});

test("§GEP-0010: a container holding only prose IS the container, and gets no run address", () => {
  const runs = proseRunTargets(parse("# Only {#only}\n\njust prose.\n").children);
  assert.deepEqual([...runs.keys()], [], "both anchors absent — `#only` already names it");
});

test("§GEP-0010: an explicit id shadows the run address it would collide with", () => {
  const src = "# A {#a}\n\nprose.\n\n=== note {#a-before-b}\nI am a real block.\n===\n\n=== code {#b lang=sh}\nx\n===\n";
  const d = parse(src);
  assert.equal(errors(d).length, 0);
  const hit = addressedUnits(src).find((u) => u.unit.id === "a-before-b");
  assert.equal(hit.unit.kind, "block", "the declared block wins; the run goes unnamed");
});

test("§GEP-0010: a reference resolves a run address, in this document and across one", () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-proj-"));
  writeFileSync(join(dir, "pub.geml"), PUB);

  // Cross-document, which is the form a projection actually uses.
  const cn = `=== meta
title = "x"
profile = "geml-translator/v1"
===

=== embed {src=pub.geml#pub-before-cmd}
===
`;
  writeFileSync(join(dir, "cn.geml"), cn);
  const resolveDoc = (p) => (p === "pub.geml" ? PUB : null);
  assert.equal(errors(parse(cn, { resolveDoc })).length, 0, "a run address is not an unresolved reference");

  // And a typo still is — the point of addressing them at all is that a miss is loud.
  const bad = cn.replace("#pub-before-cmd", "#pub-before-nope");
  const e = errors(parse(bad, { resolveDoc })).map((x) => x.code);
  assert.deepEqual(e, ["unresolved-cross-document-reference"]);
});

// `part=` is what lets a projection be ALL embeds. Without it a heading had to be
// hand-written in the projecting document — and hand-written text is the drift
// this proposal exists to remove.
test("§GEP-0010: `part=` narrows a heading's section to head, body or intro", () => {
  const kinds = (part) => selectEmbed(parse(PUB).children, "pub", part).map((b) => b.kind + (b.id ? `#${b.id}` : ""));

  assert.deepEqual(kinds("head"), ["heading#pub"], "the heading LINE alone");
  assert.deepEqual(kinds("whole")[0], "heading#pub");
  assert.ok(kinds("whole").length > 1);

  // head + body partition the whole — which is what makes this a rule.
  assert.deepEqual([...kinds("head"), ...kinds("body")], kinds("whole"));

  // intro stops at the first SUBHEADING; body does not.
  assert.ok(kinds("body").includes("heading#verify"));
  assert.ok(!kinds("intro").includes("heading#verify"));
  assert.deepEqual(kinds("intro"), ["paragraph", "block#cmd", "paragraph"]);

  // A target that is not a heading has no halves; the whole of it stands rather
  // than the selection quietly becoming empty.
  assert.deepEqual(selectEmbed(parse(PUB).children, "cmd", "head").map((b) => b.id), ["cmd"]);
});

test("§GEP-0010: an unrecognised `part=` warns and keeps the whole target", () => {
  const d = parse('=== embed {src=a.geml#b part=middle}\n===\n');
  // `bad-embed-part`, NOT `unknown-attribute`: the key is defined, the value is
  // not one it takes, and a gate matching on the codes must be able to tell those
  // apart. Caught by measuring the attribute table rather than by reading it.
  const w = d.diagnostics.filter((x) => x.code === "bad-embed-part");
  assert.equal(w.length, 1);
  assert.equal(w[0].severity, "warning");
  assert.match(w[0].message, /is not `whole`, `head`, `body` or `intro`/);
  assert.equal(d.diagnostics.filter((x) => x.code === "unknown-attribute").length, 0);
});

// The three intents a projection has to express, and how "write nothing" changes
// meaning once a document declares a default — which is the reason the hold-back
// moved onto `translate-to` rather than staying on `translator`.
test("§GEP-0010: a document default, an override, and a hold-back", () => {
  const meta = { "translate-to": "zh-cn" };

  assert.equal(resolveTarget(meta, {}), "zh-cn", "write nothing: inherit the default");
  assert.equal(resolveTarget(meta, { "translate-to": "ja" }), "ja", "override it");
  assert.equal(resolveTarget(meta, { "translate-to": "none" }), null, "hold this one back");

  // With no default, writing nothing still means no translation.
  assert.equal(resolveTarget({}, {}), null);
  assert.equal(resolveTarget(undefined, { "translate-to": "fr" }), "fr");

  // `none` as the DEFAULT is a document that translates nothing unless asked.
  assert.equal(resolveTarget({ "translate-to": "none" }, {}), null);
  assert.equal(resolveTarget({ "translate-to": "none" }, { "translate-to": "ja" }), "ja");

});

test("§GEP-0010: `translate-to=`/`translator=` need the profile, and are clean with it", () => {
  const unknown = (src) => parse(src).diagnostics.filter((x) => x.code === "unknown-attribute").length;
  const embed = (attrs, meta = "") =>
    `=== meta\n${meta}===\n\n=== embed {src=a.geml#b ${attrs}}\n===\n`;

  assert.equal(unknown(embed("translate-to=zh-cn")), 1, "without the profile it is unknown");
  assert.equal(unknown(embed("translate-to=zh-cn", 'profile = "geml-translator/v1"\n')), 0);

  // `translator=` is NOT an embed attribute: it names the engine, which is an
  // environment-wide choice, so it lives on `=== meta` where any key is legal.
  assert.equal(unknown(embed("translator=chrome", 'profile = "geml-translator/v1"\n')), 1);

  // There is no `except=` either: the document default made a per-embed mosaic
  // cheap enough that a second way to say "leave this alone" earns nothing.
  assert.equal(unknown(embed('except="#x"', 'profile = "geml-translator/v1"\n')), 1);
});

// What a translation may touch. The policy is per TYPE, and the inline type makes
// the second half fall out: text says something, a link target names something.
const shout = (s) => (s.trim() === "" ? s : `«${s.trim()}»`);

test("§GEP-0010: prose is translated; a code span and a link target are not", () => {
  const d = parse("# Title {#t}\n\nRun `npm publish` and [read the docs](https://example.com/a).\n");
  const asked = [];
  const out = translateBlocks(d.children, "xx", (s) => { asked.push(s); return shout(s); });
  const md = gemlToMd({ ...d, children: out }).md;
  assert.match(md, /«Title»/, "heading text");
  assert.match(md, /`npm publish`/, "a code span is a verbatim atom");
  assert.doesNotMatch(md, /«npm publish»/);
  assert.match(md, /\(https:\/\/example\.com\/a\)/, "a link href names a target");
  assert.match(md, /read the docs/, "a link label says something and comes through");

  // The amendment: the paragraph crosses as ONE sentence with placeholders where
  // the atoms were, not as the three fragments a per-text-node walk sent ("Run ",
  // " and ", "."). Fragments are what made word order unrecoverable, and a lone
  // "." is what came back as a half-width period in a Chinese paragraph.
  const para = asked.filter((s) => s.includes("Run"));
  assert.equal(para.length, 1, "the paragraph is one call, not several");
  assert.doesNotMatch(para[0], /npm publish/, "the code span is masked, never sent");
  assert.doesNotMatch(para[0], /example\.com/, "nor the link target");
  assert.match(para[0], /Run [\s\S]* and [\s\S]*docs/, "but the sentence around them is intact");
  assert.equal(asked.filter((s) => /^[^A-Za-z]+$/.test(s)).length, 0,
    "no bare-punctuation fragment is ever sent");
});

test("§GEP-0010: a code body is never translated, a table's cells are", () => {
  const d = parse(PUB);
  const md = gemlToMd({ ...d, children: translateBlocks(d.children, "xx", shout) }).md;
  assert.match(md, /npm publish/);
  assert.doesNotMatch(md, /«npm publish»/, "a code body is the value, not a sentence about one");
  assert.match(md, /«artifact»/, "a table of prose is the case body mode gets wrong");
  assert.match(md, /«parser»/);
});

test("§GEP-0010: translating never mutates the source blocks", () => {
  const d = parse("para.\n");
  const before = d.children[0].text;
  translateBlocks(d.children, "xx", shout);
  assert.equal(d.children[0].text, before, "the caller's blocks come from a parse cache others read");
});

// The glossary half of the amendment. A settled translation is applied by the
// projection layer; the engine never sees the term, so it cannot re-decide it.

const GLOSS = new Map([["Doc-as-a-Base", "文档即真相之源"], ["Single Source of Truth", "单一事实来源"]]);

test("§GEP-0010: a glossary term is masked from the engine and comes back settled", () => {
  const d = parse("Doc-as-a-Base is the Single Source of Truth.\n");
  const asked = [];
  const out = translateBlocks(d.children, "zh-cn", (s) => { asked.push(s); return s; }, { glossary: GLOSS });
  const md = gemlToMd({ ...d, children: out }).md;
  assert.equal(asked.length, 1, "still one call");
  assert.doesNotMatch(asked[0], /Doc-as-a-Base/, "the engine never sees the term");
  assert.doesNotMatch(asked[0], /Single Source of Truth/);
  assert.match(md, /文档即真相之源/, "and the settled translation is what lands");
  assert.match(md, /单一事实来源/);
});

test("§GEP-0010: a term the glossary does not name is left to the engine", () => {
  const d = parse("Doc-as-a-Base and blocks.\n");
  const out = translateBlocks(d.children, "zh-cn", () => "文档即真相之源 与 区块。", { glossary: GLOSS });
  // the engine answer carries no placeholder, so the masked term is DROPPED —
  // which is exactly the round-trip failure the next test pins.
  assert.match(gemlToMd({ ...d, children: out }).md, /Doc-as-a-Base and blocks/, "source kept");
});

test("§GEP-0010: a mangled placeholder keeps the source, never a holed sentence", () => {
  const d = parse("Run `npm publish` now.\n");
  const src = gemlToMd(d).md;
  for (const [why, engine] of [
    ["dropped", (s) => s.replace(/[\ue000][^\ue001]*[\ue001]/gu, "")],
    ["duplicated", (s) => s + s],
    ["unknown index", () => String.fromCharCode(0xe000) + "99" + String.fromCharCode(0xe001)],
  ]) {
    const out = translateBlocks(d.children, "xx", engine);
    assert.equal(gemlToMd({ ...d, children: out }).md, src, `a ${why} placeholder falls back to the source`);
  }
});

test("§GEP-0010: glossaryFrom reads the hidden table its meta points at", () => {
  const d = parse([
    '=== meta', 'glossary = "#not-translated-terms"', '===', '',
    "=== table {#not-translated-terms hidden}",
    "| term | zh-cn |", "|---|---|",
    "| Doc-as-a-Base | 文档即真相之源 |",
    "| GEML | GEML |",
    "===", "",
  ].join("\n"));
  const meta = { glossary: "#not-translated-terms" };
  const g = glossaryFrom(d.children, meta);
  assert.equal(g.get("Doc-as-a-Base"), "文档即真相之源");
  assert.equal(g.get("GEML"), "GEML", "a do-not-translate row is a row like any other");
  assert.equal(glossaryFrom(d.children, {}), null, "no glossary key, no glossary");
  assert.equal(glossaryFrom(d.children, { glossary: "#nope" }), null, "an id that names nothing");
});

test("§GEP-0010: a list item is one call, and a nested item is its own", () => {
  const d = parse("- first **bold** item\n  - nested one\n- second item\n");
  const asked = [];
  const out = translateBlocks(d.children, "xx", (s) => { asked.push(s); return shout(s); });
  const md = gemlToMd({ ...d, children: out }).md;
  assert.equal(asked.filter((s) => s.includes("first")).length, 1, "the item crosses whole, bold and all");
  assert.match(md, /«first/, "translated");
  assert.match(md, /nested one/, "a nested item is translated too, not dropped");
  assert.match(md, /\*\*bold\*\*/, "and the emphasis survives the round trip");
});

test("§GEP-0010: an image alt is prose, its src is a name", () => {
  const d = parse("See ![a red chart](chart.png) here.\n");
  const asked = [];
  const out = translateBlocks(d.children, "xx", (s) => { asked.push(s); return shout(s); });
  const md = gemlToMd({ ...d, children: out }).md;
  assert.match(md, /\(chart\.png\)/, "the src names a file");
  assert.match(md, /«a red chart»/, "the alt says something, so it is translated on its own");
  assert.ok(asked.some((s) => s.includes("See") && !s.includes("red chart")),
    "and the sentence around it is masked, not cut at the image");
});

// --- what the projection must NOT do, at each seam -------------------------
//
// The placeholder protocol is the whole safety story of GEP-0010: a sentence
// crosses to an engine with markers standing in for everything the engine must
// not touch, and comes back only if every marker came back exactly once. The
// refusals below are what stands between "the engine reordered my markers" and
// a document whose links point at the wrong words. Each one yields the SOURCE.
const OPEN = String.fromCharCode(0xe000);
const CLOSE = String.fromCharCode(0xe001);
const ph = (n) => `${OPEN}${n}${CLOSE}`;
const phEnd = (n) => `${OPEN}/${n}${CLOSE}`;
const inlinesOf = (src) => parse(src).children[0].inlines;

test("§GEP-0010: a wrapper the engine crossed or never closed yields the SOURCE", () => {
  const two = inlinesOf("*one* and **two**\n");
  // Crossed: `⟦0⟧⟦1⟧⟦/0⟧⟦/1⟧` closes the outer wrapper while the inner is open,
  // which would put the emphasis around the wrong run.
  const crossed = translateInlines(two, "xx", () => ph(0) + ph(1) + phEnd(0) + phEnd(1));
  assert.deepEqual(crossed, two, "crossed markers are not a translation");
  // Unclosed: an opener with no closer has no run to wrap at all.
  const unclosed = translateInlines(two, "xx", () => ph(0) + "x" + phEnd(1) + ph(1));
  assert.deepEqual(unclosed, two);
  // Opened and simply left open: the wrapper has no run to close around.
  assert.deepEqual(translateInlines(two, "xx", () => ph(0) + "still open"), two);
  // And a marker for a slot that does not exist.
  assert.deepEqual(translateInlines(two, "xx", () => ph(7)), two);
});

test("§GEP-0010: a sentence that is ONLY a marker is never sent", () => {
  // A paragraph that is one code span masks to a bare placeholder: there is no
  // prose left, and an engine handed a marker invents an answer for it.
  const asked = [];
  const bare = inlinesOf("`ls -la`\n");
  const out = translateInlines(bare, "xx", (s) => { asked.push(s); return "翻译了"; });
  assert.deepEqual(asked, [], "the engine was not asked");
  assert.deepEqual(out, bare, "and the code span is untouched");
});

test("§GEP-0010: an image's alt is prose, an EMPTY alt is not", () => {
  const asked = [];
  const t = (s) => { asked.push(s); return s.toUpperCase(); };
  const withAlt = translateInlines(inlinesOf("![a cat](c.png)\n"), "xx", t);
  assert.equal(withAlt[0].alt, "A CAT");
  const noAlt = translateInlines(inlinesOf("![](c.png)\n"), "xx", t);
  assert.equal(noAlt[0].alt, "", "an empty alt is not a sentence to translate");
  assert.ok(!asked.includes(""), "and it is never sent as one");
});

test("§GEP-0010: an empty glossary term would mask everything, so it is skipped", () => {
  // `indexOf("")` is 0 for every string: one empty key would replace the whole
  // sentence with a placeholder, term by term, forever.
  const gloss = new Map([["", "×"], ["block", "区块"]]);
  const out = translateInlines(inlinesOf("a block here\n"), "zh-cn", (s) => s, { glossary: gloss });
  assert.equal(out.map((n) => n.value ?? "").join(""), "a 区块 here");
});

test("§GEP-0010: the flat form covers every inline kind, including the textless ones", () => {
  // `text` is rebuilt from the translated inlines, and a kind missing from that
  // walk would silently shorten it — `autoref`/`project` contribute nothing
  // (they show the target's text at render time), a break contributes a space.
  const d = parse("# H {#h}\n\n*emph* and ~~gone~~, see [[#h]] and `code`\\\nnext line\n");
  const out = translateBlocks(d.children, "xx", (s) => s);
  const para = out.find((b) => b.kind === "paragraph");
  assert.match(para.text, /emph and gone, see  and code next line/);
});

test("§GEP-0010: caption= is translated, a hidden line is not, and a raw body is copied", () => {
  const asked = [];
  const t = (s) => { asked.push(s); return `T(${s})`; };
  const d = parse([
    "%% a note to the author, never a reader",
    '=== code {#c lang=sh caption="Cut the release"}',
    "npm publish",
    "===",
    "",
    "=== note {#n}",
    "prose inside a flow body",
    "===",
    "",
    "=== data {#d format=json}",
    '{"a": 1}',
    "===",
  ].join("\n"));
  const out = translateBlocks(d.children, "xx", t);
  const code = out.find((b) => b.kind === "block" && b.type === "code");
  assert.equal(code.attrs["caption"], "T(Cut the release)", "caption= says something, so it is prose");
  assert.deepEqual(code.raw, ["npm publish"], "and the body is not");
  const note = out.find((b) => b.kind === "block" && b.type === "note");
  assert.match(note.children[0].text, /^T\(/, "a flow body recurses");
  const data = out.find((b) => b.kind === "block" && b.type === "data");
  assert.deepEqual(data.value, { a: 1 }, "a data body is the value, not a sentence about one");
  assert.ok(out.some((b) => b.kind === "hidden"), "the hidden line survives, untranslated");
  assert.ok(!asked.some((s) => /npm publish|\{"a"/.test(s)), "neither raw body was ever sent");
});

test("§GEP-0010: a table's prose crosses and its NUMBERS do not", () => {
  const asked = [];
  const t = (s) => { asked.push(s); return `T(${s})`; };
  // GEP-0012: the report row belongs to a `view`, and a translation must treat
  // a view's relation exactly as a table's — prose crosses, numbers do not.
  const d = parse([
    "=== table {#facts format=csv header=1}",
    "Segment, Q1",
    "Cloud, 8",
    "===",
    "",
    '=== view {#fy src=#facts caption="Quarterly revenue" summary="Segment = \'Total\'; Q1 = sum(Q1)"}',
    "===",
  ].join("\n"));
  const tbl = translateBlocks(d.children, "xx", t)[1].table;
  assert.equal(tbl.caption, "T(Quarterly revenue)");
  assert.deepEqual(tbl.columns, ["T(Segment)", "T(Q1)"]);
  assert.equal(tbl.rows[0][0].text, "T(Cloud)");
  assert.equal(tbl.rows[0][1].text, "8", "a cell the model computes over is data");
  assert.equal(tbl.summary[1].text, "8", "and so is a computed foot cell");
  assert.ok(!asked.includes("8"), "the number was never sent");
});

test("§GEP-0010: glossaryFrom answers null for a target it cannot read here", () => {
  const cross = parse('=== meta\nglossary = "other.geml#g"\n===\n\n# H {#h}\n\nx\n');
  assert.equal(glossaryFrom(cross.children, { glossary: "other.geml#g" }), null,
    "a cross-document glossary is the caller's to resolve, not this function's");
  const empty = parse([
    "=== meta",
    'glossary = "#g"',
    "===",
    "",
    "=== table {#g hidden format=csv header=1}",
    "term, zh",
    "===",
    "",
    "# H {#h}",
    "",
    "x",
  ].join("\n"));
  assert.equal(glossaryFrom(empty.children, { glossary: "#g" }), null,
    "a table with no rows pins no terms, and an empty map would mask nothing");
});

console.log(`\n${passed} test(s) passed.`);
