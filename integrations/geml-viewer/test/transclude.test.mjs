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
]);

async function view(src, { docUrl = BASE, caps, docs = DOCS, log } = {}) {
  const { document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
  const model = parse(src);
  const root = renderDocument(model, document);
  await expandTransclusions(root, {
    parse,
    docUrl,
    children: model.children,
    caps,
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

// --- run ---------------------------------------------------------------------

for (const [name, fn] of tests) {
  await fn();
  passed++;
  console.log("ok", name);
}
console.log(`\n${passed} transclude tests passed.`);
