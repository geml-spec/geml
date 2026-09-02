// Freezing what the reader is looking at. The point of taking the snapshot HERE
// rather than in the CLI is that this side has a translator; the point of these
// tests is that it reports what it could not translate instead of quietly
// shipping half a translation.
import { parse } from "../../../geml-parser/dist/geml.js";
import { renderDocument } from "../src/render.js";
import { expandTransclusions } from "../src/transclude.js";
import { snapshot } from "../src/snapshot.js";
import { parseHTML } from "linkedom";
import { strict as assert } from "node:assert";

const BASE = "https://host.test/docs/main.geml";
const SRC = `## Target section {#sec}

Section paragraph.
`;
const DOCS = new Map([["https://host.test/docs/other.geml", SRC]]);

const PROJ = `=== meta
profile = "geml-translator/v1"
translate-to = "zh"
===

=== table {#terms hidden}
| term | zh |
|---|---|
| a | b |
===

=== embed {src=other.geml#sec}
===
`;

async function view(src, translateSlice) {
  const { document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
  const model = parse(src);
  const root = renderDocument(model, document);
  await expandTransclusions(root, {
    parse, docUrl: BASE, children: model.children,
    ...(translateSlice ? { translateSlice } : {}),
    fetchText: async (url) => DOCS.get(url) ?? null,
  });
  return { model, root };
}

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const shout = async (blocks) => ({
  ok: true,
  blocks: blocks.map((b) => (b.inlines ? { ...b, inlines: [{ type: "text", value: "译文" }] } : b)),
});

test("a snapshot carries the TRANSLATION, and no trace of the projection's plumbing", async () => {
  const { model, root } = await view(PROJ, shout);
  const { md, untranslated } = snapshot(model, root);
  assert.match(md, /译文/, "what the reader sees is what is frozen");
  assert.doesNotMatch(md, /Section paragraph/, "and not the source it was projected from");
  assert.doesNotMatch(md, /=== embed|other\.geml/, "the embed is resolved, not carried");
  assert.doesNotMatch(md, /term \| zh/, "the hidden glossary is not part of what is read");
  assert.equal(untranslated.length, 0);
});

test("a section showing its source is NAMED, never silently frozen as English", async () => {
  const refuse = async () => ({ ok: false, why: "the editor did not answer in time", retryable: true });
  const { model, root } = await view(PROJ, refuse);
  const { md, untranslated } = snapshot(model, root);
  assert.match(md, /Section paragraph/, "the source is what is on screen, so it is what is frozen");
  assert.equal(untranslated.length, 1, "and the caller is told");
  assert.match(untranslated[0].why, /did not answer in time/);
  assert.match(untranslated[0].src, /other\.geml#sec/);
});

test("the snapshot follows the reader: swap a section back and it holds the source", async () => {
  const { model, root } = await view(PROJ, shout);
  assert.match(snapshot(model, root).md, /译文/);
  const btn = root.querySelector(".geml-transclusion button");
  btn.dispatchEvent(new root.ownerDocument.defaultView.Event("click"));
  await new Promise((r) => setTimeout(r, 0));
  const after = snapshot(model, root);
  assert.match(after.md, /Section paragraph/, "the reader chose the source, so that is the snapshot");
  assert.doesNotMatch(after.md, /译文/);
});

test("a document with nothing to expand snapshots as itself", async () => {
  const { model, root } = await view("# Title {#t}\n\nplain paragraph.\n");
  const { md, untranslated } = snapshot(model, root);
  assert.match(md, /plain paragraph/);
  assert.equal(untranslated.length, 0);
});

for (const [name, fn] of tests) {
  await fn();
  console.log(`ok ${name}`);
  passed++;
}
console.log(`\n${passed} snapshot tests passed.`);
