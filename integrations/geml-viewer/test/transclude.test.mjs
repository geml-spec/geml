// Transclusion-expansion tests: parse real GEML, render it, run the async
// expansion pass with an injected fetchText (a Map of absolute URL → text),
// and assert the DOM. Semantics under test mirror geml-parser/src/render.ts:
// slice selection, budgets, cycles, and the no-anchors rule for borrowed
// content. Uses linkedom; transclude.js is pure, so this runs in Node.
import { parse } from "../../../geml-parser/dist/geml.js";
import { renderDocument } from "../src/render.js";
import {
  expandTransclusions,
  EMBED_DEPTH_CAP, EMBED_TOTAL_CAP, EMBED_BYTES_CAP, EMBED_DOC_BYTES_CAP,
} from "../src/transclude.js";
import { parseHTML } from "linkedom";
import { strict as assert } from "node:assert";

const BASE = "https://host.test/docs/main.geml";

const OTHER = `## Target section {#sec}

Section paragraph, see [[#tip]].

### Sub-heading

Sub paragraph.

## Next section {#next}

Outside the target.

=== note {#tip}
Borrowed note body.
===
`;

const DOCS = new Map([
  ["https://host.test/docs/other.geml", OTHER],
  // Inline projection targets: a `text` block holding ONE paragraph is the only
  // projectable shape (geml-parser projectableInlines); a note and a two-
  // paragraph text are the two ways to be "not inline".
  ["https://host.test/docs/phrases.geml", `=== text {#status}
all *systems* nominal, see [[#tip2]]
===

=== text {#two}
first para

second para
===

=== note {#nope}
a note is not projectable
===

=== note {#tip2}
Tip body.
===

=== text {#rel}
a [link](sub/page.html) and ![pic](img/p.png)
===
`],
  // Self-projecting phrase: #loop projects itself, so the chain must stop.
  ["https://host.test/docs/loop.geml", `=== text {#loop}
before ![[loop.geml#loop]] after
===
`],
  ["https://host.test/docs/whole.geml", `=== meta {#m}
title = "W"
===

## Whole doc {#w}

Whole-doc paragraph.
`],
  ["https://host.test/docs/mathy.geml", `=== math {#eq}
E = mc^2
===
`],
  ["https://host.test/docs/a.geml", `Paragraph of a.

=== embed {src=b.geml}
===
`],
  ["https://host.test/docs/b.geml", `Paragraph of b.

=== embed {src=a.geml}
===
`],
  // depth chain without fragments (a #id that misses would stop the chain early)
  ["https://host.test/docs/c1.geml", `c1 body.

=== embed {src=c2.geml}
===
`],
  ["https://host.test/docs/c2.geml", `c2 body.

=== embed {src=c3.geml}
===
`],
  ["https://host.test/docs/c3.geml", `c3 body.
`],
  ["https://host.test/docs/sub/inner.geml", `inner body.

=== embed {src=deep.geml}
===
`],
  ["https://host.test/docs/sub/deep.geml", `deep body.
`],
  ["https://host.test/docs/sub/media.geml", `![shot](img/pic.png)

See [notes](notes.md) and [away](#away).

## Away {#away}

x
`],
  ["https://host.test/docs/dup.geml", `## Borrowed dup {#dup}

borrowed body
`],
  ["https://host.test/docs/meta-src.geml", `=== meta {#m}
k = "SRC"
===

Value is {{k}}.
`],
  // A table whose data lives beside IT, not beside the host — and written the
  // bare way, which is legal §4 and what the parser reads identically.
  ["https://host.test/docs/tabular.geml", `=== table {#t format=csv header=1 src=sub/rows.csv}
===
`],
  ["https://host.test/docs/sub/rows.csv", "Segment, Q1\nCloud, 10\nHardware, 30\n"],
  // GEP 0010 — prose between blocks, which bears no id of its own.
  ["https://host.test/docs/pub.geml", `# Publishing {#pub}

Cut the release from a clean tree.

=== code {#cmd lang=sh}
npm publish
===

Then confirm it landed.
`],
]);

async function view(src, { docUrl = BASE, caps, docs = DOCS, log, translateSlice, onPaint } = {}) {
  const { document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
  const model = parse(src);
  const root = renderDocument(model, document);
  await expandTransclusions(root, {
    parse,
    docUrl,
    children: model.children,
    caps,
    ...(translateSlice ? { translateSlice } : {}),
    ...(onPaint ? { onPaint } : {}),
    fetchText: async (url) => {
      if (log) log.push(url);
      const t = docs.get(url);
      return t === undefined ? null : t;
    },
  });
  return root;
}

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// GEP 0010 — the browser has its OWN selectEmbed, and it went on refusing prose
// addresses after the reference renderer learned them: opened from disk, every
// projection of prose read "no `#pub-before-cmd` in `publishing.geml`" while the
// block embeds beside it expanded. Both now resolve the address through the
// parser's proseRunTargets, so there is one definition of what an address names.
// A projection whose translation is refused shows its SOURCE. Saying so only in
// `data-translation-note` meant the reader saw a page of English with no sign it
// was meant to be anything else — indistinguishable from a document that was
// always in that language. Whatever the reason, it is now on the page.
test("a refused translation says so where the reader can see it", async () => {
  const src = `=== meta\nprofile = "geml-translator/v1"\ntranslate-to = "zh-cn"\n===\n\n=== embed {src=pub.geml#pub-before-cmd}\n===\n`;
  delete globalThis.Translator;
  delete globalThis.LanguageDetector;

  const root = await view(src);
  const note = root.querySelector(".geml-translate-refused");
  assert.ok(note, "the refusal is a visible element, not only a data attribute");
  assert.match(note.textContent, /Not translated to zh-cn/);
  assert.match(note.textContent, /Translator/);
  // The source still stands — a refusal never blanks the content.
  assert.match(root.textContent, /Cut the release from a clean tree\./);
});

test("a prose address expands, and an unknown one still refuses", async () => {
  const root = await view(`=== embed {src=pub.geml#pub-before-cmd}\n===\n`);
  assert.match(root.textContent, /Cut the release from a clean tree\./);
  assert.equal(root.querySelectorAll(".geml-transclusion-expanded").length, 1);

  const bad = await view(`=== embed {src=pub.geml#pub-before-nope}\n===\n`);
  assert.match(bad.textContent, /no `#pub-before-nope`/);
});

// --- inline projections (`![[#id]]`) ---------------------------------------
// These went unexpanded in the browser for as long as they existed: the pass
// selected only `div.geml-transclusion-unexpanded`, so a phrase stayed the
// degraded link the first paint drew while the reference renderer expanded it.

test("an inline projection expands in place, with its markup", async () => {
  const root = await view("Status: ![[phrases.geml#status]] today.\n");
  const span = root.querySelector("span.geml-transclusion-inline-expanded");
  assert.ok(span, "the phrase was swapped in");
  assert.equal(span.getAttribute("data-src"), "phrases.geml#status");
  assert.match(span.textContent, /all systems nominal/);
  assert.ok(span.querySelector("em"), "borrowed *systems* is emphasis here too");
  assert.equal(root.querySelectorAll("a.geml-transclusion-inline-unexpanded").length, 0);
  assert.match(root.textContent, /Status: all systems nominal.*today\./s, "it sits inside the sentence");
});

test("a same-document projection needs no fetch", async () => {
  const log = [];
  const root = await view("=== text {#here}\nlocal *phrase*\n===\n\nSee ![[#here]].\n", { log });
  assert.deepEqual(log, [], "nothing was fetched");
  assert.match(root.querySelector("span.geml-transclusion-inline-expanded").textContent, /local phrase/);
});

test("a projection of non-inline content keeps the link and says why", async () => {
  for (const [src, why] of [["phrases.geml#nope", /not inline/], ["phrases.geml#two", /not inline/],
                            ["phrases.geml#ghost", /no `#ghost`/]]) {
    const root = await view(`x ![[${src}]] y\n`);
    const a = root.querySelector("a.geml-transclusion-inline-unexpanded");
    assert.ok(a, `${src}: the reader still sees what was meant to be borrowed`);
    assert.match(a.getAttribute("title"), why, src);
    assert.equal(root.querySelectorAll("span.geml-transclusion-inline-expanded").length, 0, src);
  }
});

test("a projecting phrase that projects itself stops instead of recursing", async () => {
  const root = await view("x ![[loop.geml#loop]] y\n");
  // The outer one expands; the copy of itself inside it is the cycle and stops.
  assert.match(root.textContent, /before/);
  const refused = root.querySelector("a.geml-transclusion-error");
  assert.ok(refused, "the inner phrase is refused, not followed");
  assert.match(refused.getAttribute("title"), /transclusion cycle/);
});

test("borrowed phrases own no anchors and their relative links point home", async () => {
  const root = await view("x ![[phrases.geml#rel]] y\n");
  const span = root.querySelector("span.geml-transclusion-inline-expanded");
  assert.equal(span.querySelector("a").getAttribute("href"), "https://host.test/docs/sub/page.html");
  assert.equal(span.querySelector("img").getAttribute("src"), "https://host.test/docs/img/p.png");
  assert.equal(span.querySelectorAll("[id]").length, 0, "no borrowed id lands in the host namespace");
});

test("inline projections spend the SAME budget as block embeds", async () => {
  const root = await view("![[phrases.geml#status]] and ![[phrases.geml#status]]\n", { caps: { total: 1 } });
  assert.equal(root.querySelectorAll("span.geml-transclusion-inline-expanded").length, 1);
  const refused = root.querySelector("a.geml-transclusion-too-large");
  assert.ok(refused, "the second is refused on the shared expansion count");
});

test("a projection may not name a non-GEML document", async () => {
  const root = await view("x ![[evil.txt#a]] y\n");
  assert.match(root.querySelector("a.geml-transclusion-invalid").getAttribute("title"), /not a GEML document/);
});


// --- expansion -------------------------------------------------------------

test("cross-document block target expands in place", async () => {
  const root = await view(`=== embed {#mine src=other.geml#tip}
===
`);
  const wrap = root.querySelector(".geml-transclusion");
  assert.ok(wrap, "wrapper kept");
  assert.ok(!wrap.className.includes("unexpanded"), "no longer unexpanded");
  assert.ok(wrap.className.includes("geml-transclusion-expanded"), "expanded state class");
  assert.equal(wrap.getAttribute("data-src"), "other.geml#tip", "data-src preserved");
  assert.equal(wrap.getAttribute("id"), "mine", "wrapper keeps its OWN host id");
  const note = wrap.querySelector("blockquote.geml-note");
  assert.ok(note && /Borrowed note body/.test(note.textContent), "target block rendered");
});

test("heading target takes its whole section, not the rest of the document", async () => {
  const root = await view(`=== embed {src=other.geml#sec}
===
`);
  const wrap = root.querySelector(".geml-transclusion");
  const text = wrap.textContent;
  assert.ok(/Target section/.test(text), "heading itself");
  assert.ok(/Section paragraph/.test(text), "section body");
  assert.ok(/Sub paragraph/.test(text), "deeper heading stays inside");
  assert.ok(!/Next section/.test(text) && !/Outside the target/.test(text), "stops at same-level heading");
});

test("no fragment transcludes the whole document minus meta", async () => {
  const root = await view(`=== embed {src=whole.geml}
===
`);
  const wrap = root.querySelector(".geml-transclusion");
  assert.ok(/Whole-doc paragraph/.test(wrap.textContent), "body present");
  assert.ok(!/title = "W"/.test(wrap.textContent), "meta not shown");
});

test("same-document src=#id expands without any fetch", async () => {
  const log = [];
  const root = await view(`## Local {#loc}

Local paragraph.

=== embed {src=#loc}
===
`, { log });
  assert.equal(log.length, 0, "no network");
  const wrap = root.querySelector(".geml-transclusion");
  assert.ok(/Local paragraph/.test(wrap.textContent), "expanded from host model");
});

test("a borrowed document's src= table loads its data, like the host's does", async () => {
  // content.js inlines `src=` tables for the HOST before parsing (§6); a fetched
  // document has to get the same pass, or the identical table renders its rows
  // at home and "Data not loaded from …" once transcluded — one document, two
  // answers, decided by who was reading it. The CLI's --root render loads it.
  const log = [];
  const root = await view(`=== embed {src=tabular.geml#t}
===
`, { log });
  const wrap = root.querySelector(".geml-transclusion");
  const table = wrap.querySelector("table");
  assert.ok(table, `borrowed table rendered, not a placeholder: ${wrap.textContent.trim()}`);
  assert.ok(/Cloud/.test(table.textContent), "the fetched rows are in it");
  // The CSV is fetched relative to the BORROWED document, not the host.
  assert.ok(log.includes("https://host.test/docs/sub/rows.csv"),
    `csv resolved against its own document: ${JSON.stringify(log)}`);
});

test("borrowed math renders as an upgradeable placeholder", async () => {
  const root = await view(`=== embed {src=mathy.geml#eq}
===
`);
  const tex = root.querySelector(".geml-transclusion .geml-math-display");
  assert.ok(tex, "math placeholder inside borrowed content");
  assert.equal(tex.getAttribute("data-tex"), "E = mc^2");
});

// --- borrowed content owns no anchors ---------------------------------------

test("ids inside borrowed content demote to data-embed-id", async () => {
  const root = await view(`=== embed {#mine src=other.geml#sec}
===
`);
  const wrap = root.querySelector(".geml-transclusion");
  assert.equal(wrap.getAttribute("id"), "mine");
  assert.equal(wrap.querySelectorAll("[id]").length, 0, "no borrowed anchors on the host page");
  const h = wrap.querySelector('[data-embed-id="sec"]');
  assert.ok(h && /^H/.test(h.tagName), "original id kept as data-embed-id");
});

test("a borrowed id colliding with a host id leaves the host anchor alone", async () => {
  const root = await view(`## Host dup {#dup}

host body

=== embed {src=dup.geml#dup}
===
`);
  const anchors = root.querySelectorAll('[id="dup"]');
  assert.equal(anchors.length, 1, "exactly one #dup on the page");
  assert.ok(/Host dup/.test(anchors[0].textContent), "and it is the host's");
  assert.ok(root.querySelector('.geml-transclusion [data-embed-id="dup"]'), "borrowed one demoted");
});

test("fragment links inside borrowed content point back at the source document", async () => {
  const root = await view(`=== embed {src=other.geml#sec}
===
`);
  const a = [...root.querySelectorAll(".geml-transclusion a")].find((x) => /tip/.test(x.getAttribute("href") || ""));
  assert.ok(a, "autoref rendered");
  assert.equal(a.getAttribute("href"), "https://host.test/docs/other.geml#tip");
});

test("relative src/href inside borrowed content rebase onto the source URL", async () => {
  const root = await view(`=== embed {src=sub/media.geml}
===
`);
  const wrap = root.querySelector(".geml-transclusion");
  assert.equal(wrap.querySelector("img").getAttribute("src"),
    "https://host.test/docs/sub/img/pic.png", "image loads from the SOURCE's directory");
  const links = [...wrap.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"));
  assert.ok(links.includes("https://host.test/docs/sub/notes.md"), "relative doc link rebased");
  assert.ok(links.includes("https://host.test/docs/sub/media.geml#away"), "fragment link points at the source");
});

test("{{key}} inside borrowed content interpolates the SOURCE document's meta", async () => {
  const root = await view(`=== meta {#hm}
k = "HOST"
===

Host says {{k}}.

=== embed {src=meta-src.geml}
===
`);
  const wrap = root.querySelector(".geml-transclusion");
  assert.ok(/Value is SRC\./.test(wrap.textContent), "source meta wins inside the embed");
  assert.ok(!/HOST/.test(wrap.textContent), "host meta does not leak in");
  assert.ok(/Host says HOST\./.test(root.textContent), "host paragraph untouched");
});

// --- refusals keep the link and say why --------------------------------------

test("a missing id degrades to link + note", async () => {
  const root = await view(`=== embed {src=other.geml#nope}
===
`);
  const wrap = root.querySelector(".geml-transclusion-unexpanded");
  assert.ok(wrap, "stays unexpanded");
  assert.ok(wrap.className.includes("geml-transclusion-unresolved"), "kind class");
  assert.ok(wrap.querySelector("a"), "target link kept");
  assert.equal(wrap.querySelector(".geml-transclusion-note").textContent, "no `#nope` in `other.geml`");
});

test("an unfetchable document degrades to link + note", async () => {
  const root = await view(`=== embed {src=missing.geml#x}
===
`);
  const note = root.querySelector(".geml-transclusion-note");
  assert.equal(note.textContent, "cannot resolve document `missing.geml`, or it is too large");
});

test("a cross-origin target the fetch gate refuses degrades the same way", async () => {
  const log = [];
  const root = await view(`=== embed {src=https://evil.test/x.geml#id}
===
`, { log });
  assert.deepEqual(log, ["https://evil.test/x.geml"], "resolved absolute, gate said null");
  assert.ok(/cannot resolve document/.test(root.querySelector(".geml-transclusion-note").textContent));
});

test("a non-.geml target is refused", async () => {
  const root = await view(`=== embed {src=data.csv#x}
===
`);
  const note = root.querySelector(".geml-transclusion-note");
  assert.equal(note.textContent, "`data.csv` is not a GEML document");
});

test("a blanked src (unsafe scheme) is left exactly as painted", async () => {
  // The parser blanks `src=javascript:…` at parse time; the renderer paints
  // "embed: missing src=" and this pass must not touch it.
  const root = await view(`=== embed {src=javascript:alert(1)}
===
`);
  const wrap = root.querySelector(".geml-transclusion-unexpanded");
  assert.ok(/missing src=/.test(wrap.textContent));
  assert.equal(wrap.querySelector(".geml-transclusion-note"), null, "no note added");
});

// --- cycles ------------------------------------------------------------------

test("A→B→A is reported as a cycle, not an infinite loop", async () => {
  const root = await view(`=== embed {src=a.geml}
===
`);
  const err = root.querySelector(".geml-transclusion-error");
  assert.ok(err, "cycle surfaced");
  assert.ok(/^transclusion cycle: /.test(err.textContent));
  assert.ok(/a\.geml → .*b\.geml → .*a\.geml/.test(err.textContent), "readable chain");
  assert.ok(/Paragraph of a/.test(root.textContent) && /Paragraph of b/.test(root.textContent),
    "content above the cycle still expanded");
});

test("a heading slice that contains its own embed is the smallest cycle", async () => {
  const root = await view(`## Sec {#s}

In section.

=== embed {src=#s}
===
`);
  const outer = root.querySelector(".geml-transclusion");
  assert.ok(outer, "outer expansion happened");
  const err = outer.querySelector(".geml-transclusion-error");
  assert.ok(err && /transclusion cycle:/.test(err.textContent), "inner copy stops");
});

// --- budgets -------------------------------------------------------------------

test("cap values are pinned to the parser's", () => {
  assert.equal(EMBED_DEPTH_CAP, 8);
  assert.equal(EMBED_TOTAL_CAP, 1000);
  assert.equal(EMBED_BYTES_CAP, 8 * 1024 * 1024);
  assert.equal(EMBED_DOC_BYTES_CAP, 4 * 1024 * 1024);
});

test("depth cap stops the chain with a note", async () => {
  const root = await view(`=== embed {src=c1.geml}
===
`, { caps: { depth: 2 } });
  assert.ok(/c1 body/.test(root.textContent) && /c2 body/.test(root.textContent), "in-budget hops expanded");
  assert.ok(!/c3 body/.test(root.textContent), "hop past the cap did not");
  const note = root.querySelector(".geml-transclusion-too-deep .geml-transclusion-note");
  assert.equal(note.textContent, "transclusion depth cap (2) reached");
});

test("expansion-count budget spends across the whole page", async () => {
  const root = await view(`=== embed {src=other.geml#tip}
===

=== embed {src=other.geml#sec}
===
`, { caps: { total: 1 } });
  assert.equal(root.querySelectorAll(".geml-transclusion-note").length, 1, "second embed refused");
  assert.ok(/budget spent \(1 expansions\)/.test(root.textContent));
});

test("byte budget spends across the whole page", async () => {
  const root = await view(`=== embed {src=other.geml#tip}
===

=== embed {src=other.geml#sec}
===
`, { caps: { bytes: 1 } });
  assert.ok(/budget spent \(1 bytes\)/.test(root.textContent), "second embed hit the byte cap");
});

test("an oversize single document is refused", async () => {
  const root = await view(`=== embed {src=other.geml#tip}
===
`, { caps: { docBytes: 16 } });
  assert.ok(/cannot resolve document `other\.geml`, or it is too large/.test(root.textContent));
});

// --- resolution + caching -------------------------------------------------------

test("one document is fetched once for two embeds", async () => {
  const log = [];
  await view(`=== embed {src=other.geml#tip}
===

=== embed {src=other.geml#sec}
===
`, { log });
  assert.deepEqual(log, ["https://host.test/docs/other.geml"]);
});

test("relative src inside borrowed content resolves against ITS document", async () => {
  const log = [];
  const root = await view(`=== embed {src=sub/inner.geml}
===
`, { log });
  assert.deepEqual(log, [
    "https://host.test/docs/sub/inner.geml",
    "https://host.test/docs/sub/deep.geml", // NOT /docs/deep.geml
  ]);
  assert.ok(/deep body/.test(root.textContent), "nested hop expanded");
});

test("a #fragment on the page URL does not leak into resolution", async () => {
  const log = [];
  await view(`=== embed {src=other.geml#tip}
===
`, { docUrl: BASE + "#somewhere", log });
  assert.deepEqual(log, ["https://host.test/docs/other.geml"]);
});

// A refusal often ends in the one page that fixes it — install this, sign in
// there. The note is the only place a reader sees that, so a trailing URL has to
// be clickable rather than something to retype by hand.
const TRANSLATED_DOC = `=== meta
profile = "geml-translator/v1"
translate-to = "zh-cn"
===

=== embed {src=pub.geml#pub-before-cmd}
===
`;

test("a refusal ending in an https URL renders it as a link", async () => {
  const why = "no language model provider is installed — install GitHub Copilot Chat: https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat";
  const root = await view(TRANSLATED_DOC, { translateSlice: async () => ({ ok: false, why }) });
  const note = root.querySelector(".geml-translate-refused");
  assert.ok(note, "the reader is told at all");
  assert.match(note.textContent, /Not translated to zh-cn/);
  const link = note.querySelector("a");
  assert.ok(link, "and the place to go is a link");
  assert.equal(link.getAttribute("href"), "https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat");
  assert.equal(link.textContent, link.getAttribute("href"), "the link shows where it goes");
});

test("a refusal with no URL, or an unnavigable one, stays plain text", async () => {
  for (const why of [
    "Copilot Chat is installed but offers no model",
    "this browser has no built-in Translator; chrome://on-device-internals shows whether the models are available",
    "see https://example.test/why for details",  // a URL that is not trailing
  ]) {
    const root = await view(TRANSLATED_DOC, { translateSlice: async () => ({ ok: false, why }) });
    const note = root.querySelector(".geml-translate-refused");
    assert.ok(note.textContent.includes(why), why);
    // assert.ok, not assert.equal: a failing equal would try to diff a DOM
    // node, and serialising one of those exhausts the heap — the failure then
    // reads as "Array buffer allocation failed" instead of naming the case.
    assert.ok(!note.querySelector("a"), `no link for: ${why}`);
  }
});

// A host runs its own passes over what the renderer painted — KaTeX, mermaid,
// the code-graph mount — once, after expansion. The reader toggling a section
// back to its source repaints it long after that, and the rebuilt placeholders
// would sit there as their own source text: a mermaid diagram showing
// "graph TD; A-->B". So a post-expansion paint tells the host.

const TOGGLE_DOC = `=== meta
profile = "geml-translator/v1"
translate-to = "zh-cn"
===

=== embed {src=pub.geml#pub-before-cmd}
===
`;
const SAME_DOC = `=== meta
profile = "geml-translator/v1"
translate-to = "zh-cn"
===

# Here {#sec}

Some prose.

=== embed {src=#sec}
===
`;
const upper = async (blocks) => ({ ok: true, blocks });

test("expansion itself does not call onPaint", async () => {
  const painted = [];
  await view(TOGGLE_DOC, { translateSlice: upper, onPaint: (el) => painted.push(el) });
  // The source goes up and the translation replaces it, both before the host has
  // upgraded anything — calling back then would upgrade the same nodes twice.
  assert.equal(painted.length, 0);
});

test("a toggle back to the source calls onPaint, so diagrams can be re-upgraded", async () => {
  const painted = [];
  const root = await view(TOGGLE_DOC, { translateSlice: upper, onPaint: (el) => painted.push(el) });
  const btn = root.querySelector("button.geml-source-toggle");
  assert.ok(btn, "the toggle is there to click");
  btn.dispatchEvent(new root.ownerDocument.defaultView.Event("click"));
  assert.equal(painted.length, 1, "the repaint notified once");
  assert.ok(painted[0].querySelector, "and handed over the element that changed");
  btn.dispatchEvent(new root.ownerDocument.defaultView.Event("click"));
  assert.equal(painted.length, 2, "and again on the way back");
});

test("a same-document projection notifies too", async () => {
  // src=#id returns early from the S4 rebasing, which is exactly where a
  // carelessly placed notify would have been skipped — and same-document is the
  // common shape.
  const painted = [];
  const root = await view(SAME_DOC, { translateSlice: upper, onPaint: (el) => painted.push(el) });
  const btn = root.querySelector("button.geml-source-toggle");
  assert.ok(btn, "the toggle is there for a same-document projection as well");
  btn.dispatchEvent(new root.ownerDocument.defaultView.Event("click"));
  assert.equal(painted.length, 1);
});

test("an onPaint that throws does not take the toggle down with it", async () => {
  const root = await view(TOGGLE_DOC, {
    translateSlice: upper,
    onPaint: () => { throw new Error("mermaid exploded"); },
  });
  const btn = root.querySelector("button.geml-source-toggle");
  btn.dispatchEvent(new root.ownerDocument.defaultView.Event("click"));
  // The paint already happened; the host's failure is logged, not propagated.
  assert.ok(root.textContent.length > 0, "the section still has content");
});

// --- run ---------------------------------------------------------------------

// --- concurrency: the knob is 1 by default, and these pin what turning it must
// not break. The shape that motivated it is 17 embeds of ONE source document.

const lanesBackend = (n) => {
  const f = async (blocks) => ({ ok: true, blocks });
  f.concurrency = n;
  return f;
};

test("lanes fetch a shared source ONCE, not once per embed", async () => {
  const log = [];
  const src = "=== embed {src=other.geml#sec translate-to=zh}\n===\n".repeat(6);
  const root = await view(src, { log, translateSlice: lanesBackend(4) });
  const fetched = log.filter((u) => u.endsWith("other.geml")).length;
  assert.equal(fetched, 1, "the in-flight promise is cached, so five lanes wait on the first fetch");
  assert.equal(root.querySelectorAll(".geml-transclusion-expanded").length, 6, "and all six expand");
});

test("the expansion budget still holds when lanes run concurrently", async () => {
  const src = "=== embed {src=other.geml#sec translate-to=zh}\n===\n".repeat(6);
  const root = await view(src, { caps: { total: 2 }, translateSlice: lanesBackend(4) });
  assert.equal(root.querySelectorAll(".geml-transclusion-expanded").length, 2,
    "reserved before the await, so four lanes cannot all pass a cap of two");
  assert.ok(/budget spent \(2 expansions\)/.test(root.textContent));
});

test("a refused embed hands its reservation back", async () => {
  // The refusal comes first, so a budget it kept would starve the two after it.
  // Serial (the default) is where this is exact: the refusal returns its
  // reservation before the next embed checks.
  const src = "=== embed {src=missing.geml#sec}\n===\n" + "=== embed {src=other.geml#sec translate-to=zh}\n===\n".repeat(2);
  const root = await view(src, { caps: { total: 2 }, translateSlice: lanesBackend(1) });
  assert.equal(root.querySelectorAll(".geml-transclusion-expanded").length, 2,
    "the two real embeds still fit the cap of two");
});

test("with lanes the budget may UNDER-admit, and never over-admit", async () => {
  // A reservation is held across the fetch, so an embed that will be refused
  // occupies budget until it fails. A lane checking inside that window is turned
  // away even though the budget comes back. That is the safe direction for a
  // resource guard — the cap is never exceeded — and it is why the default is 1:
  // serial expansion is exact, lanes trade exactness for latency.
  const src = "=== embed {src=missing.geml#sec}\n===\n" + "=== embed {src=other.geml#sec translate-to=zh}\n===\n".repeat(2);
  const root = await view(src, { caps: { total: 2 }, translateSlice: lanesBackend(4) });
  const n = root.querySelectorAll(".geml-transclusion-expanded").length;
  assert.ok(n <= 2, `never over the cap (expanded ${n})`);
  assert.equal(n, 1, "and here the in-flight refusal costs the third lane its slot");
});

// A refusal the reader can clear gets a button; one they cannot gets only a note.
const SRC_PROJ = `=== meta\nprofile = "geml-translator/v1"\ntranslate-to = "zh"\n===\n\n=== embed {src=other.geml#sec}\n===\n`;

test("a retryable refusal offers a button, and the click translates that section", async () => {
  let calls = 0;
  const flaky = async (blocks) => {
    calls++;
    return calls === 1
      ? { ok: false, why: "the editor did not answer in time", retryable: true }
      : { ok: true, blocks };
  };
  const root = await view(SRC_PROJ, { translateSlice: flaky });
  const btn = root.querySelector(".geml-translate-offer button");
  assert.ok(btn, "the refusal is actionable, not just reported");
  assert.match(root.textContent, /did not answer in time/, "and it says why");
  await btn.dispatchEvent(new root.ownerDocument.defaultView.Event("click"));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls, 2, "the click asked again");
  assert.equal(root.querySelector(".geml-translate-offer"), null,
    "and a success repaints the section, taking the bar with it");
});

test("a refusal nothing can clear gets a note, not a button", async () => {
  const never = async () => ({ ok: false, why: "this browser has no built-in Translator" });
  const root = await view(SRC_PROJ, { translateSlice: never });
  assert.match(root.textContent, /no built-in Translator/);
  assert.equal(root.querySelector(".geml-translate-offer button"), null,
    "a button that cannot help is worse than none");
});

test("a translated section can be swapped back to its source, and forward again", async () => {
  // GEP-0010 drawback 1: the projection is live and not reviewable. This does not
  // make it reviewable, but it lets a reader SEE what a word replaced.
  const shout = async (blocks) => ({
    ok: true,
    blocks: blocks.map((b) => (b.inlines ? { ...b, inlines: [{ type: "text", value: "TRANSLATED" }] } : b)),
  });
  const root = await view(SRC_PROJ, { translateSlice: shout });
  assert.match(root.textContent, /TRANSLATED/, "the translation is what shows first");
  const btn = () => root.querySelector(".geml-transclusion button");
  assert.equal(btn().textContent, "原文", "and the control speaks the target language");

  const click = async () => {
    btn().dispatchEvent(new root.ownerDocument.defaultView.Event("click"));
    await new Promise((r) => setTimeout(r, 0));
  };
  await click();
  assert.match(root.textContent, /Section paragraph/, "the source is back");
  assert.doesNotMatch(root.textContent, /TRANSLATED/);
  assert.equal(btn().textContent, "译文", "and the control now offers the way back");
  await click();
  assert.match(root.textContent, /TRANSLATED/, "and back again — the bar survives its own repaint");
});

test("an embed with no translation to compare gets no toggle", async () => {
  const root = await view("=== embed {src=other.geml#sec}\n===\n");
  assert.match(root.textContent, /Section paragraph/);
  assert.equal(root.querySelector(".geml-transclusion button"), null,
    "nothing was translated, so there are not two things to swap between");
});

test("the source is readable BEFORE the translator answers, with a bar saying so", async () => {
  // Expansion is serial, so waiting for a translation before painting made the
  // last of 17 sections show a placeholder for as long as the sixteen above it
  // took. The translator is asked only after the source is on screen.
  const { document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
  const model = parse(SRC_PROJ);
  const root = renderDocument(model, document);
  let textWhenAsked = null;
  let barWhenAsked = null;
  const slow = async (blocks) => {
    textWhenAsked = root.textContent;
    barWhenAsked = root.querySelector(".geml-translate-offer")?.textContent ?? null;
    return { ok: true, blocks: blocks.map((b) => (b.inlines ? { ...b, inlines: [{ type: "text", value: "TRANSLATED" }] } : b)) };
  };
  await expandTransclusions(root, {
    parse, docUrl: BASE, children: model.children, translateSlice: slow,
    fetchText: async (url) => DOCS.get(url) ?? null,
  });
  assert.match(textWhenAsked, /Section paragraph/, "the source was already painted");
  assert.equal(barWhenAsked, "翻译中…", "and the reader was told the words are about to change");
  assert.match(root.textContent, /TRANSLATED/, "then the translation swapped in");
  assert.equal(root.querySelector(".geml-translate-offer"), null,
    "the pending bar is gone once the translation lands");
  const toggle = root.querySelector("h2 > .geml-source-toggle");
  assert.ok(toggle, "and the switch rides at the end of the section heading, not in a bar of its own");
  assert.equal(toggle.textContent, "原文");
});

test("borrowed-content rules survive a repaint, not just the first paint", async () => {
  // S9 and S4 used to run once, after the only paint there was. With the source
  // painted first and a translation swapping in — and a reader able to swap back
  // — a slice that skipped them would carry raw ids and unrebased links.
  const keep = async (blocks) => ({ ok: true, blocks });
  const root = await view(SRC_PROJ, { translateSlice: keep });
  const after = () => ({
    ids: root.querySelectorAll(".geml-transclusion [id]").length,
    demoted: root.querySelectorAll("[data-embed-id]").length,
  });
  assert.equal(after().ids, 0, "no borrowed id reaches the host namespace");
  assert.ok(after().demoted > 0, "they were demoted, not dropped");
  const btn = root.querySelector(".geml-transclusion button");
  btn.dispatchEvent(new root.ownerDocument.defaultView.Event("click"));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(after().ids, 0, "and the same holds after swapping back to the source");
  assert.ok(after().demoted > 0);
});

for (const [name, fn] of tests) {
  await fn();
  passed++;
  console.log("ok", name);
}
console.log(`\n${passed} transclude tests passed.`);
