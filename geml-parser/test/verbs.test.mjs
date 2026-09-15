// The verbs as pure functions (src/verbs.ts), driven directly — no CLI, no
// files, no MCP. The CLI and MCP suites cover the happy paths through their own
// surfaces; what lives here are the branches only a direct caller can reach
// cheaply: every refusal a verb can throw, the content channel bound to an
// in-memory reader, `--view` chains over an in-memory document set, `revert`
// over an in-memory history, and the corners of `list`'s column layout.
//
// Everything is in memory on purpose. A VerbContext with no `files` is the
// stateless host's; one with an in-memory FileAccess stands in for a disk.
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  VerbError, ViewError, NO_CONTENT,
  add, check, del, findInSource, formatFindRows, get, list, rename, replace, revert, set, transform,
} from "../dist/verbs.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const none = { resolveDoc: () => null, docExists: () => false };

// A context that resolves nothing and records notes.
function ctxOf(files) {
  const notes = [];
  const ctx = { docOpts: () => none, note: (l) => notes.push(l), notes };
  if (files) {
    ctx.files = {
      readConfined(rel) {
        if (!/\.geml$/i.test(rel)) throw new ViewError("embed-target-not-geml", `embed-target-not-geml: \`${rel}\` is not a \`.geml\` document`);
        if (!(rel in files)) throw new ViewError("unresolvable-document", `unresolvable-document: cannot resolve \`${rel}\``);
        return files[rel];
      },
      shownPath: (rel) => rel,
    };
  }
  return ctx;
}

// The `--in F[#src]` channel over an in-memory set of files.
function fileContent(spec, files) {
  return {
    kind: "file",
    spec,
    read(path) {
      if (!(path in files)) throw new VerbError(`cannot read ${path}`, 1);
      return files[path];
    },
  };
}
const raw = (text) => ({ kind: "raw", text });

// Assert a VerbError with the CLI's exit status; returns it for message checks.
function refused(fn, exit) {
  try { fn(); }
  catch (e) {
    assert.ok(e instanceof VerbError, `expected a VerbError, got ${e?.constructor?.name}: ${e?.message}`);
    if (exit !== undefined) assert.equal(e.exit, exit, `exit status for: ${e.message}`);
    return e;
  }
  assert.fail("expected a refusal");
}

const DOC =
  "# Intro {#intro}\n\n" +
  "Opening words.\n\n" +
  "=== note {#alpha}\nfirst\n===\n\n" +
  "=== note {#beta}\nsee [[#alpha]]\n===\n\n" +
  "## Sub {#sub}\n\nunder sub\n";

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

test("an empty selector is a usage error on get and on set", () => {
  const e = refused(() => get(DOC, "d.geml", "", { part: "whole", json: false, view: false }, ctxOf()), 2);
  assert.match(e.message, /no selector given/);
  refused(() => set(DOC, "d.geml", "", { part: "whole", named: [], content: raw("x") }, ctxOf()), 2);
});

test("an attribute filter is refused, naming the type when there is one", () => {
  const typed = refused(() => get(DOC, "d.geml", "=== note {key=v}", { part: "whole", json: false, view: false }, ctxOf()), 2);
  assert.match(typed.message, /use `=== note` for every note block/);
  const bare = refused(() => get(DOC, "d.geml", "{key=v}", { part: "whole", json: false, view: false }, ctxOf()), 2);
  assert.match(bare.message, /address a block by `#id`/);
});

test("a line selector past the end, single or range, names the span it could not place", () => {
  const one = refused(() => get(DOC, "d.geml", "L999", { part: "whole", json: false, view: false }, ctxOf()), 1);
  assert.match(one.message, /no block contains L999 in d\.geml/);
  const range = refused(() => get(DOC, "d.geml", "L1-999", { part: "whole", json: false, view: false }, ctxOf()), 1);
  assert.match(range.message, /no block contains L1-999/);
});

test("a heading line resolves by text, then by level; a phrase matching nothing says so", () => {
  // Two headings with the same TEXT need distinct ids (a derived slug would
  // collide), so the ids are explicit; the selector still speaks the text.
  const two = "# Same {#s1}\n\ntop\n\n## Other {#o}\n\n### Same {#s3}\n\ndeep\n";
  const o = { part: "whole", json: false, view: false };
  assert.match(get(two, "d.geml", "### Same", o, ctxOf()).output, /^### Same \{#s3\}/);
  assert.match(get(two, "d.geml", "# Same", o, ctxOf()).output, /^# Same \{#s1\}/);
  // Text shared by two headings at a level neither has: listed, not guessed.
  const amb = refused(() => get(two, "d.geml", "#### Same", o, ctxOf()), 1);
  assert.match(amb.message, /matches 2 headings/);
  assert.match(amb.message, /#s1  \(h1\)[\s\S]*#s3  \(h3\)/);
  const none = refused(() => get(two, "d.geml", "## Nowhere To Be Found", o, ctxOf()), 1);
  assert.match(none.message, /no id or heading matches `## Nowhere To Be Found`/);
  // A lone `#word` that matches nothing is handed back as an id, so the
  // caller's own "no block with id" stands.
  const id = refused(() => get(two, "d.geml", "#nope", o, ctxOf()), 1);
  assert.match(id.message, /^no block with id `nope`$/);
});

test("`#meta` answers the merged view unless a block claims the id or there is nothing to merge", () => {
  const o = { part: "whole", json: false, view: false };
  const meta = "=== meta\ntitle = \"T\"\n===\n\n=== meta\nauthor = \"A\"\n===\n\n# H {#h}\n";
  assert.equal(get(meta, "d.geml", "#meta", o, ctxOf()).output, "title = \"T\"\nauthor = \"A\"\n");
  assert.equal(get(meta, "d.geml", "#meta[\"title\"]", o, ctxOf()).output, "T\n");
  assert.equal(get(meta, "d.geml", "#meta[\"title\"]", { ...o, json: true }, ctxOf()).output, "\"T\"\n");
  assert.deepEqual(JSON.parse(get(meta, "d.geml", "#meta", { ...o, json: true }, ctxOf()).output), { title: "T", author: "A" });
  const bad = refused(() => get(meta, "d.geml", "#meta[\"nope\"]", o, ctxOf()), 1);
  assert.match(bad.message, /no key `nope`/);
  refused(() => get(meta, "d.geml", "#meta", { ...o, part: "head", partFlag: "--head" }, ctxOf()), 2);
  // A block that claims `{#meta}` IS the view: the ordinary id path answers.
  const claimed = "=== meta {#meta}\ntitle = \"T\"\n===\n";
  assert.match(get(claimed, "d.geml", "#meta", o, ctxOf()).output, /^=== meta \{#meta\}/);
  // No meta block at all: `#meta` is just an id nobody has.
  const e = refused(() => get("# H {#h}\n", "d.geml", "#meta", o, ctxOf()), 1);
  assert.match(e.message, /no block with id `meta`/);
});

test("a coordinate refuses a part flag and --view; a bad path names the failure", () => {
  const tbl = "=== table {#t format=csv}\nA,B\n1,2\n3,4\n===\n";
  const o = { part: "whole", json: false, view: false };
  assert.equal(get(tbl, "d.geml", "#t[1][\"A\"]", o, ctxOf()).output, "1\n");
  assert.equal(JSON.parse(get(tbl, "d.geml", "#t[2][\"B\"]", { ...o, json: true }, ctxOf()).output).value, 4);
  refused(() => get(tbl, "d.geml", "#t[1][\"A\"]", { ...o, part: "body", partFlag: "--body" }, ctxOf()), 2);
  refused(() => get(tbl, "d.geml", "#t[1][\"A\"]", { ...o, view: true }, ctxOf()), 2);
  const bad = refused(() => get(tbl, "d.geml", "#t[9][\"A\"]", o, ctxOf()), 1);
  assert.match(bad.message, /^`#t\[9\]\["A"\]`: /);
});

test("N matches by type are counted on the side channel; --intro on a block is refused", () => {
  const ctx = ctxOf();
  const r = get(DOC, "d.geml", "=== note", { part: "whole", json: false, view: false }, ctx);
  assert.equal(r.output, "=== note {#alpha}\nfirst\n===\n=== note {#beta}\nsee [[#alpha]]\n===\n");
  assert.deepEqual(ctx.notes, ["2 `note` blocks (L5-7 #alpha · L9-11 #beta)"]);
  const e = refused(() => get(DOC, "d.geml", "#alpha", { part: "intro", partFlag: "--intro", json: false, view: false }, ctxOf()), 2);
  assert.match(e.message, /--intro names a heading's opening region, and `#alpha` is a `note` block/);
  // --json returns N nodes for N matches, one node for one.
  const nodes = JSON.parse(get(DOC, "d.geml", "=== note", { part: "whole", json: true, view: false }, ctxOf()).output);
  assert.equal(nodes.length, 2);
  assert.equal(JSON.parse(get(DOC, "d.geml", "#sub", { part: "whole", json: true, view: false }, ctxOf()).output).kind, "section");
});

// ---------------------------------------------------------------------------
// --view over an in-memory document set
// ---------------------------------------------------------------------------

const FILES = {
  "main.geml": "=== embed {#e src=part.geml#tip}\n===\n\n=== embed {#all src=part.geml}\n===\n\n=== embed {#bare}\n===\n\n=== embed {#flag src}\n===\n",
  "part.geml": "=== meta\ntitle = \"P\"\n===\n\n=== note {#tip}\nthe tip\n===\n\n# Section {#s}\n\nbody\n",
  "a.geml": "=== embed {#e src=b.geml#f}\n===\n",
  "b.geml": "=== embed {#f src=a.geml#e}\n===\n",
  "md.geml": "=== embed {#e src=notes.md#x}\n===\n",
};
const V = { part: "whole", json: false, view: true };

test("--view follows a fragment to the entity block and reports where it came from", () => {
  const ctx = ctxOf(FILES);
  const r = get(FILES["main.geml"], "main.geml", "#e", V, ctx);
  assert.equal(r.output, "=== note {#tip}\nthe tip\n===\n");
  assert.deepEqual(r.from, ["part.geml#tip"]);
  assert.deepEqual(ctx.notes, ["view: #e -> part.geml#tip"]);
});

test("--view on a whole-document frame yields its top-level blocks, meta excluded", () => {
  const r = get(FILES["main.geml"], "main.geml", "#all", V, ctxOf(FILES));
  assert.equal(r.output, "=== note {#tip}\nthe tip\n===\n# Section {#s}\n\nbody\n");
  // --json carries provenance on each node; a whole-document target has no `#`.
  const nodes = JSON.parse(get(FILES["main.geml"], "main.geml", "#all", { ...V, json: true }, ctxOf(FILES)).output);
  assert.deepEqual(nodes.map((n) => n.from), [{ doc: "part.geml" }, { doc: "part.geml" }]);
  const one = JSON.parse(get(FILES["main.geml"], "main.geml", "#e", { ...V, json: true }, ctxOf(FILES)).output);
  assert.deepEqual(one.from, { doc: "part.geml", id: "tip" });
});

test("--view is the identity on an embed without a usable src, and on any non-embed block", () => {
  assert.equal(get(FILES["main.geml"], "main.geml", "#bare", V, ctxOf(FILES)).output, "=== embed {#bare}\n===\n");
  assert.equal(get(FILES["main.geml"], "main.geml", "#flag", V, ctxOf(FILES)).output, "=== embed {#flag src}\n===\n");
  const r = get(DOC, "d.geml", "#alpha", V, ctxOf());
  assert.equal(r.output, "=== note {#alpha}\nfirst\n===\n");
  assert.deepEqual(r.from, []);
});

test("--view refusals: no other documents, a non-GEML target, a missing target, a cycle, a URL", () => {
  const e1 = refused(() => get(FILES["main.geml"], "main.geml", "#e", V, ctxOf()), 1);
  assert.match(e1.message, /holds no other documents/);
  const e2 = refused(() => get(FILES["md.geml"], "md.geml", "#e", V, ctxOf(FILES)), 1);
  assert.equal(e2.code, "embed-target-not-geml");
  const e3 = refused(() => get("=== embed {#e src=gone.geml#x}\n===\n", "x.geml", "#e", V, ctxOf(FILES)), 1);
  assert.equal(e3.code, "unresolvable-document");
  const e4 = refused(() => get(FILES["a.geml"], "a.geml", "#e", V, ctxOf(FILES)), 1);
  assert.equal(e4.code, "transclusion-cycle");
  const e5 = refused(() => get("=== embed {#e src=https://x.test/p.geml#x}\n===\n", "x.geml", "#e", V, ctxOf(FILES)), 1);
  assert.equal(e5.code, "unchecked-cross-document-reference");
});

// ---------------------------------------------------------------------------
// list / find
// ---------------------------------------------------------------------------

test("list pads by terminal columns, flags footnotes and unknown types, and says when there is nothing", () => {
  // A CJK id in the ADDRESS column: two cells per character, so padding by
  // code units would push every later column of that row out of true.
  const src = "=== meta\ntitle = \"T\"\n===\n\n# 中文标题 {#中文}\n\n=== note {#n .footnote}\nfn\n===\n\n=== bogus {#b}\nx\n===\n\n## Ẹmoji 🎉 {#e}\n\ntext\n";
  const out = list(src, "d.geml", false, ctxOf());
  const lines = out.trimEnd().split("\n");
  assert.equal(lines[0], "#meta  meta     anon  L1-3");
  assert.match(lines[1], /^#中文\s+heading\s+h1\s+L5-\d+\s+中文标题$/);
  assert.match(lines[2], /footnote$/);
  assert.match(lines[3], /unknown type$/);
  assert.match(lines[4], /🎉/);
  // The `L` column sits at the same CELL offset on every row (a wide character
  // is two cells, a combining mark none) — that is what the padding is for.
  const cells = (s) => [...s].reduce((w, ch) => {
    const c = ch.codePointAt(0);
    if (c >= 0x0300 && c <= 0x036f) return w;
    return w + ((c >= 0x2e80 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xff00 && c <= 0xff60) || c >= 0x1f300 ? 2 : 1);
  }, 0);
  const lCol = lines.map((l) => cells(l.slice(0, l.search(/L\d+-\d+/))));
  assert.ok(lCol.every((c) => c === lCol[0]), `columns drifted: ${JSON.stringify(lCol)} in ${JSON.stringify(lines)}`);
  assert.ok(lines[1].search(/L\d+-\d+/) < lines[0].search(/L\d+-\d+/), "the CJK row uses fewer code units to reach the same cell");
  // A paragraph under no heading has no address (a prose run is addressed
  // relative to its heading), so both these documents are empty answers.
  const ctx = ctxOf();
  assert.equal(list("just prose\n", "p.geml", false, ctx), "");
  assert.equal(list("", "e.geml", false, ctx), "");
  assert.deepEqual(ctx.notes, ["no addressable blocks in p.geml", "no addressable blocks in e.geml"]);
  assert.equal(list("", "-", true, ctxOf()), "[]\n");
});

test("find reports each block once, with the matching line on request, and formats rows for pasting", () => {
  const hits = findInSource(DOC, "d.geml", "SEE", { sensitive: false, withLine: true });
  assert.deepEqual(hits, [{ file: "d.geml", address: "#beta", kind: "note", lines: [9, 11], line: "see [[#alpha]]" }]);
  assert.equal(formatFindRows(hits, true), "d.geml\t#beta\tsee [[#alpha]]");
  assert.equal(formatFindRows(hits, false), "d.geml\t#beta");
  assert.deepEqual(findInSource(DOC, "d.geml", "SEE", { sensitive: true, withLine: false }), []);
});

// ---------------------------------------------------------------------------
// check / transform
// ---------------------------------------------------------------------------

test("check parses under the given root; transform covers every format pair and its refusals", () => {
  assert.equal(check(DOC, "d.geml", ctxOf()).diagnostics.length, 0);
  const o = (inFmt, outFmt, extra = {}) => ({ inFmt, outFmt, fragment: false, ...extra });
  const json = transform(DOC, "d.geml", o("geml", "json"), ctxOf());
  assert.equal(JSON.parse(json.output).kind, "document");
  // A model without a diagnostics array is given one; the round trip is byte-stable.
  const model = JSON.parse(json.output); delete model.diagnostics;
  const back = transform(JSON.stringify(model), "m.json", o("json", "geml"), ctxOf());
  assert.equal(back.output, transform(DOC, "d.geml", o("geml", "geml"), ctxOf()).output);
  assert.deepEqual(back.doc.diagnostics, []);
  refused(() => transform("{not json", "m.json", o("json", "geml"), ctxOf()), 1);
  const notModel = refused(() => transform("{\"kind\":\"x\"}", "-", o("json", "geml"), ctxOf()), 1);
  assert.match(notModel.message, /not a GEML document-model JSON/);
  const md = transform("# H\n\n- a\n", "n.md", o("md", "geml"), ctxOf());
  assert.match(md.output, /^# H/);
  assert.equal(md.doc, undefined, "the direct md -> geml projection parses nothing");
  const mdParsed = transform("# H\n\ntext\n", "n.md", o("md", "json"), ctxOf());
  assert.equal(JSON.parse(mdParsed.output).kind, "document");
  const html = transform(DOC, "d.geml", o("geml", "html", { fragment: true }), ctxOf());
  assert.doesNotMatch(html.output, /<!doctype/i);
  assert.match(html.output, /first/);
});

test("the Markdown export expands embeds: same-document with part=, cross-document through the files, and notes a translate-to it cannot honour", () => {
  const src =
    "=== meta\ntranslate-to = \"fr\"\n===\n\n# Host {#host}\n\nintro\n\n=== embed {#e1 src=#host part=head}\n===\n\n=== embed {#e2 src=#host part=bogus}\n===\n\n=== embed {#e3 src=part.geml#tip}\n===\n\n=== embed {#e4 src=gone.geml#x}\n===\n";
  const r = transform(src, "main.geml", { inFmt: "geml", outFmt: "md", fragment: false }, ctxOf(FILES));
  assert.match(r.output, /the tip/, "a cross-document embed is expanded through the files");
  assert.ok(r.notes.some((n) => /translate-to=fr/.test(n)), `translate-to noted: ${JSON.stringify(r.notes)}`);
  // Without files the cross-document embed falls back to a link; nothing throws.
  const alone = transform(src, "main.geml", { inFmt: "geml", outFmt: "md", fragment: false }, ctxOf());
  assert.doesNotMatch(alone.output, /the tip/);
});

// ---------------------------------------------------------------------------
// replace
// ---------------------------------------------------------------------------

test("replace names its scope when nothing matches, pluralises, and reports the touched blocks", () => {
  const e = refused(() => replace(DOC, "d.geml", "zzz", "y", "#alpha", ctxOf()), 1);
  assert.match(e.message, /does not occur in `#alpha` of d\.geml/);
  const e2 = refused(() => replace(DOC, "d.geml", "zzz", "y", undefined, ctxOf()), 1);
  assert.match(e2.message, /does not occur in d\.geml/);
  const r = replace(DOC, "d.geml", "s", "S", "=== note", ctxOf());
  assert.match(r.summary, /^replaced 2 occurrences in #alpha, #beta$/);
  assert.match(r.text, /firSt[\s\S]*See \[\[#alpha\]\]/);
  const one = replace(DOC, "d.geml", "Opening", "Closing", undefined, ctxOf());
  assert.match(one.summary, /^replaced 1 occurrence in /);
  const idSwap = refused(() => replace(DOC, "d.geml", "#alpha", "#omega", undefined, ctxOf()), 2);
  assert.match(idSwap.message, /an id is not text/);
});

// ---------------------------------------------------------------------------
// set: content channels and modes
// ---------------------------------------------------------------------------

const IN = {
  "frag.geml": "=== note {#alpha}\nfrom file\n===\n\n=== note {#other}\nother body\n===\n\n=== code {#lab lang=js}\nx\n=== #lab\n\n# Head {#head}\n\nsection body\n\n=== note {#inner}\ni\n===\n",
};

test("set's raw channel: empty, whitespace, prose and multi-block content are each refused with their own reason", () => {
  const o = (text) => ({ part: "whole", named: [], content: raw(text) });
  assert.equal(refused(() => set(DOC, "d.geml", "#alpha", o(""), ctxOf()), 1).message, NO_CONTENT);
  assert.equal(refused(() => set(DOC, "d.geml", "#alpha", o("  \n"), ctxOf()), 1).message, NO_CONTENT);
  assert.match(refused(() => set(DOC, "d.geml", "#alpha", o("just prose\n"), ctxOf()), 1).message, /content is prose, not a block — use --body to set the body of #alpha/);
  assert.match(refused(() => set(DOC, "d.geml", "#alpha", o("=== note\na\n===\n\n=== note\nb\n===\n"), ctxOf()), 1).message, /multiple blocks \(use add\)/);
});

test("set's file channel: whole, head and body come out of the named block; a missing file or id is refused", () => {
  const whole = set(DOC, "d.geml", "#alpha", { part: "whole", named: [], content: fileContent("frag.geml", IN) }, ctxOf());
  assert.match(whole.text, /=== note \{#alpha\}\nfrom file\n===/);
  const other = set(DOC, "d.geml", "#alpha", { part: "whole", named: [], content: fileContent("frag.geml#other", IN) }, ctxOf());
  assert.match(other.text, /=== note \{#alpha\}\nother body\n===/, "the content's id is normalized to the target's");
  const head = set(DOC, "d.geml", "#alpha", { part: "head", named: ["--head"], content: fileContent("frag.geml#lab", IN) }, ctxOf());
  assert.match(head.text, /=== code \{#alpha lang=js\}\nfirst\n===/);
  const body = set(DOC, "d.geml", "#alpha", { part: "body", named: ["--body"], content: fileContent("frag.geml#other", IN) }, ctxOf());
  assert.match(body.text, /=== note \{#alpha\}\nother body\n===/);
  // A labeled close fence and a heading section both have a body to take.
  const labeled = set(DOC, "d.geml", "#alpha", { part: "body", named: ["--body"], content: fileContent("frag.geml#lab", IN) }, ctxOf());
  assert.match(labeled.text, /=== note \{#alpha\}\nx\n===/);
  const section = set(DOC, "d.geml", "#sub", { part: "body", named: ["--body"], content: fileContent("frag.geml#head", IN) }, ctxOf());
  assert.match(section.text, /## Sub \{#sub\}\n\nsection body\n\n=== note \{#inner\}\ni\n===\n$/);
  assert.match(refused(() => set(DOC, "d.geml", "#alpha", { part: "whole", named: [], content: fileContent("missing.geml", IN) }, ctxOf()), 1).message, /^cannot read missing\.geml$/);
  assert.match(refused(() => set(DOC, "d.geml", "#alpha", { part: "whole", named: [], content: fileContent("frag.geml#nope", IN) }, ctxOf()), 1).message, /no block with id `nope` in frag\.geml/);
});

test("set --intro: only a heading has one; the opening is padded with blank lines when the content brings none", () => {
  const e = refused(() => set(DOC, "d.geml", "#alpha", { part: "intro", named: ["--intro"], content: raw("x\n") }, ctxOf()), 2);
  assert.match(e.message, /--intro names a heading's opening region, and `#alpha` is a `note` block/);
  assert.equal(refused(() => set(DOC, "d.geml", "#intro", { part: "intro", named: ["--intro"], content: raw("") }, ctxOf()), 1).message, NO_CONTENT);
  // The intro is EVERYTHING up to the first subheading — the two notes
  // included — so replacing it with a sentence drops them, and says so.
  const ctx = ctxOf();
  const r = set(DOC, "d.geml", "#intro", { part: "intro", named: ["--intro"], content: raw("New opening.") }, ctx);
  assert.equal(r.text, "# Intro {#intro}\n\nNew opening.\n\n## Sub {#sub}\n\nunder sub\n");
  assert.ok(ctx.notes.some((n) => /^dropped `#alpha`, `#beta`/.test(n)), JSON.stringify(ctx.notes));
  // Round-tripping what `get --intro` hands out changes nothing.
  const region = get(DOC, "d.geml", "#intro", { part: "intro", partFlag: "--intro", json: false, view: false }, ctxOf()).output;
  assert.equal(set(DOC, "d.geml", "#intro", { part: "intro", named: ["--intro"], content: raw(region) }, ctxOf()).text, DOC);
  const viaFile = set(DOC, "d.geml", "#intro", { part: "intro", named: ["--intro"], content: fileContent("frag.geml#other", IN) }, ctxOf());
  assert.match(viaFile.text, /^# Intro \{#intro\}\n\nother body\n\n## Sub/);
});

test("set --body on a heading section at the end of a document without a trailing newline", () => {
  const src = "# A {#a}\n\nold\n\n## B {#b}\nlast line no newline";
  const r = set(src, "d.geml", "#b", { part: "body", named: ["--body"], content: raw("new body\n") }, ctxOf());
  assert.equal(r.text, "# A {#a}\n\nold\n\n## B {#b}\nnew body\n");
  assert.equal(refused(() => set(src, "d.geml", "#b", { part: "body", named: ["--body"], content: raw("") }, ctxOf()), 1).message, NO_CONTENT);
});

test("set on `#meta[\"key\"]` and on a table coordinate, through both channels, with their refusals", () => {
  const meta = "=== meta\ntitle = \"T\"\n===\n\n=== table {#t format=csv}\nA,B\n1,2\n===\n";
  const written = set(meta, "d.geml", "#meta[\"title\"]", { part: "whole", named: [], content: raw("New\n") }, ctxOf());
  assert.match(written.text, /title = "New"/);
  const viaFile = set(meta, "d.geml", "#meta[\"title\"]", { part: "whole", named: [], content: fileContent("v.txt", { "v.txt": "FromFile" }) }, ctxOf());
  assert.match(viaFile.text, /title = "FromFile"/);
  assert.match(refused(() => set(meta, "d.geml", "#meta[\"title\"]", { part: "head", named: ["--head"], content: raw("x") }, ctxOf()), 2).message, /`#meta` names a merged view/);
  assert.equal(refused(() => set(meta, "d.geml", "#meta[\"title\"]", { part: "whole", named: [], content: raw("") }, ctxOf()), 1).message, NO_CONTENT);
  assert.match(refused(() => set(meta, "d.geml", "#meta[\"a\"][\"b\"]", { part: "whole", named: [], content: raw("x") }, ctxOf()), 1).message, /one quoted key, and nothing deeper/);
  // A coordinate inside a block: the block's body is re-planned and re-spliced.
  const cell = set(meta, "-", "#t[1][\"A\"]", { part: "whole", named: [], content: raw("9\n") }, ctxOf());
  assert.match(cell.text, /A,B\n9,2\n===/);
  assert.match(refused(() => set(meta, "-", "#t[1][\"A\"]", { part: "body", named: ["--body"], content: raw("9") }, ctxOf()), 2).message, /a coordinate already names a unit inside one/);
  assert.equal(refused(() => set(meta, "-", "#t[1][\"A\"]", { part: "whole", named: [], content: raw("") }, ctxOf()), 1).message, NO_CONTENT);
  assert.match(refused(() => set(meta, "-", "#t[9][\"A\"]", { part: "whole", named: [], content: raw("9") }, ctxOf()), 1).message, /^`#t\[9\]\["A"\]`: /);
});

test("a replacement that drops unnamed blocks is carried out and reported; one that drops a referenced id warns about the dangling reference", () => {
  const src = "# S {#s}\n\n=== note\nanon one\n===\n\n=== note {#kept}\nk\n===\n\n=== note {#ref}\nsee [[#kept]]\n===\n";
  const ctx = ctxOf();
  const r = set(src, "d.geml", "#s", { part: "whole", named: [], content: raw("# S {#s}\n\n=== note {#ref}\nsee [[#kept]]\n===\n") }, ctx);
  assert.doesNotMatch(r.text, /anon one/);
  assert.ok(ctx.notes.some((n) => /dropped `#kept` and 1 unnamed block/.test(n)), JSON.stringify(ctx.notes));
  assert.ok(ctx.notes.some((n) => /left dangling by the replacement/.test(n)), JSON.stringify(ctx.notes));
});

// ---------------------------------------------------------------------------
// add / delete / rename
// ---------------------------------------------------------------------------

test("add: a fragment without a trailing newline gets one; the file channel reads a block or a whole file; anchors must exist", () => {
  const r = add(DOC, "d.geml", { content: raw("=== note {#gamma}\ng\n==="), append: true }, ctxOf());
  assert.match(r.text, /\n=== note \{#gamma\}\ng\n===\n$/);
  const before = add(DOC, "d.geml", { content: fileContent("frag.geml#other", IN), append: false, before: "#alpha" }, ctxOf());
  assert.match(before.text, /=== note \{#other\}\nother body\n===\n\n=== note \{#alpha\}/);
  const whole = add("# Only {#only}\n", "d.geml", { content: fileContent("more.geml", { "more.geml": "=== note {#m1}\na\n===\n\n=== note {#m2}\nb\n===\n" }), append: true }, ctxOf());
  assert.match(whole.text, /#m1[\s\S]*#m2/);
  assert.match(refused(() => add(DOC, "d.geml", { content: raw("=== note {#g}\ng\n===\n"), append: false, after: "#nope" }, ctxOf()), 1).message, /no block with id `nope` in d\.geml/);
  assert.equal(refused(() => add(DOC, "d.geml", { content: raw("  \n"), append: true }, ctxOf()), 1).message, "no content to add (use --in FILE or pipe it on stdin)");
  // A whole file that cannot be read is a usage error, as the CLI has always said.
  assert.equal(refused(() => add(DOC, "d.geml", { content: fileContent("missing.geml", {}), append: true }, ctxOf()), 2).message, "cannot read missing.geml");
  assert.equal(refused(() => add(DOC, "d.geml", { content: fileContent("missing.geml#x", {}), append: true }, ctxOf()), 1).message, "cannot read missing.geml");
  const clash = refused(() => add(DOC, "d.geml", { content: raw("=== note {#alpha}\ndup\n===\n"), append: true }, ctxOf()), 1);
  assert.ok(clash.diagnostics.some((d) => d.code === "duplicate-id"));
});

test("delete skips a missing id with a note, warns about references it strands, and returns the text unchanged when nothing matched", () => {
  const ctx = ctxOf();
  const r = del(DOC, "d.geml", ["alpha", "#nope"], ctx);
  assert.doesNotMatch(r.text, /#alpha\}/);
  // The reference moved up to line 7 once #alpha's four lines were gone.
  assert.deepEqual(ctx.notes.map((n) => n.split(" —")[0]), ["skipped #nope: no such block", "warning: unresolved reference `#alpha` (line 7)"]);
  assert.equal(del(DOC, "d.geml", ["nope"], ctxOf()).text, DOC);
});

test("rename: same id, reserved id, missing id, taken id, and the history warning", () => {
  assert.match(refused(() => rename(DOC, "d.geml", "#alpha", "alpha", {}, ctxOf()), 2).message, /same id/);
  assert.match(refused(() => rename(DOC, "d.geml", "#nope", "#x", {}, ctxOf()), 1).message, /no block with id `nope`/);
  assert.match(refused(() => rename(DOC, "d.geml", "#alpha", "#beta", {}, ctxOf()), 1).message, /already exists/);
  // Renaming onto the reserved `meta` namespace — reserved once a document has
  // more than one `meta` block — makes the re-parse fail: refused with the diagnostics.
  const meta = "=== meta\ntitle = \"T\"\n===\n\n=== meta\nauthor = \"A\"\n===\n\n=== note {#n}\nx\n===\n";
  const e = refused(() => rename(meta, "d.geml", "#n", "#meta", {}, ctxOf()), 1);
  assert.match(e.message, /rename would break the document/);
  assert.ok(e.diagnostics?.some((d) => d.code === "reserved-id"), JSON.stringify(e.diagnostics));
  const ctx = ctxOf();
  const r = rename(DOC, "d.geml", "alpha", "first", { historyTip: DOC }, ctx);
  assert.match(r.text, /\{#first\}[\s\S]*\[\[#first\]\]/);
  assert.deepEqual(ctx.notes, ["warning: #alpha has history; revert across this rename is not tracked — see docs"]);
  assert.deepEqual(rename(DOC, "d.geml", "alpha", "first", { historyTip: "# other {#other}\n" }, ctxOf()) && ctxOf().notes, []);
});

// ---------------------------------------------------------------------------
// revert over an in-memory history
// ---------------------------------------------------------------------------

// Revisions newest-first: `0` is the tip, `-N` walks back. `changed` picks the
// first revision whose copy of the block differs from the current one.
function historyOf(revisions) {
  const at = (sel) => {
    if (sel === "0") return revisions[0];
    const m = /^-(\d+)$/.exec(sel);
    if (m) return revisions[+m[1]];
    return revisions.find((r) => r.id.startsWith(sel));
  };
  return {
    resolve(sel) {
      const r = at(sel);
      if (!r) throw new Error(`matched 0 revisions for \`${sel}\``);
      return r;
    },
    firstChanged(current, pick) {
      for (const r of revisions) {
        const got = pick(r.text) ?? "";
        if (got !== current) return r;
      }
      return undefined;
    },
  };
}
const R = (rev, dryRun = false, extra = {}) => ({
  rev, dryRun, headOnly: false, append: false, history: historyOf(REVS),
  historyError: (e) => `history said: ${e.message}`, ...extra,
});
const V1 = "=== note {#a}\none\n===\n\n=== note {#b}\ntwo\n===\n";
const V2 = "=== note {#a}\none\n===\n\n=== note {#b}\ntwo v2\n===\n\n=== note {#c}\nthree\n===\n";
const REVS = [{ id: "r2-tip", text: V2 }, { id: "r1-old", text: V1 }];

test("revert splices a block back, or reports it unchanged with a hint that fits the selector", () => {
  const now = V2.replace("two v2", "two v3");
  const r = revert(now, "d.geml", "#b", R("-1"), ctxOf());
  assert.equal(r.kind, "write");
  assert.equal(r.text, V2.replace("two v2", "two"));
  assert.equal(r.verb, "reverted #b to r1-old");
  const same = revert(V2, "d.geml", "#a", R("-1"), ctxOf());
  assert.deepEqual(same, { kind: "unchanged", message: "#a is unchanged at r1-old; nothing to revert (try --rev -2, or --rev changed)" });
  const dry = revert(now, "d.geml", "#b", R("0", true), ctxOf());
  assert.deepEqual(dry, { kind: "dry-run", message: "would revert #b to r2-tip:", preview: "=== note {#b}\ntwo v2\n===\n" });
});

test("revert --rev changed lands on the previous distinct version; when none exists it says so", () => {
  const r = revert(V2, "d.geml", "#b", R("changed"), ctxOf());
  assert.equal(r.verb, "reverted #b to r1-old");
  // A history whose every revision holds the same block has nothing to land on.
  const same = refused(() => revert(V2, "d.geml", "#b", R("changed", false, { history: historyOf([{ id: "same", text: V2 }]) }), ctxOf()), 1);
  assert.match(same.message, /no earlier revision changes `b`/);
  const never = refused(() => revert(V2, "d.geml", "#a", R("changed"), ctxOf()), 1);
  assert.match(never.message, /no earlier revision changes `a`/);
});

test("revert resurrects a deleted block next to its old neighbours, or where told, or at the end with a warning", () => {
  const without = "=== note {#a}\none\n===\n\n=== note {#c}\nthree\n===\n";
  const r = revert(without, "d.geml", "#b", R("0"), ctxOf());
  assert.equal(r.verb, "resurrected #b from r2-tip at after #a");
  assert.equal(r.text, V2);
  assert.equal(revert(without, "d.geml", "#b", R("0", false, { before: "#a" }), ctxOf()).verb, "resurrected #b from r2-tip at before #a");
  assert.equal(revert(without, "d.geml", "#b", R("0", false, { after: "#c" }), ctxOf()).verb, "resurrected #b from r2-tip at after #c");
  assert.equal(revert(without, "d.geml", "#b", R("0", false, { append: true }), ctxOf()).verb, "resurrected #b from r2-tip at end");
  assert.match(refused(() => revert(without, "d.geml", "#b", R("0", false, { before: "#nope" }), ctxOf()), 1).message, /no block with id `nope` in d\.geml/);
  const dry = revert(without, "d.geml", "#b", R("0", true), ctxOf());
  assert.deepEqual(dry, { kind: "dry-run", message: "would resurrect #b from r2-tip at after #a:", preview: "=== note {#b}\ntwo v2\n===\n" });
  // No neighbour survives: appended at the end, and said so before the write.
  const ctx = ctxOf();
  const lonely = revert("=== note {#z}\nz\n===\n", "d.geml", "#b", R("0"), ctx);
  assert.equal(lonely.verb, "resurrected #b from r2-tip at end");
  assert.deepEqual(ctx.notes, ["warning: anchors for #b are gone; appended at end"]);
  // --head cannot resurrect.
  assert.match(refused(() => revert(without, "d.geml", "#b", R("0", false, { headOnly: true }), ctxOf()), 2).message, /--head only applies/);
});

test("revert removes a block the revision did not have, refuses a probable rename in either direction, and reports history failures cleanly", () => {
  const r = revert(V2, "d.geml", "#c", R("-1"), ctxOf());
  assert.equal(r.verb, "removed #c (absent at r1-old)");
  // Only #c's lines go; the blank line that separated it stays, and #b keeps
  // its CURRENT text — a revert touches one block.
  assert.equal(r.text, "=== note {#a}\none\n===\n\n=== note {#b}\ntwo v2\n===\n\n");
  assert.deepEqual(revert(V2, "d.geml", "#c", R("-1", true), ctxOf()), { kind: "dry-run", message: "would remove #c (absent at r1-old)" });
  // #c's content appears at R under another id: it was renamed in, so removing it would delete that block.
  const renamedIn = "=== note {#a}\none\n===\n\n=== note {#b}\ntwo\n===\n\n=== note {#c}\ntwo\n===\n";
  assert.match(refused(() => revert(renamedIn, "d.geml", "#c", R("-1"), ctxOf()), 1).message, /looks renamed from #b/);
  // …and the other direction: the block to resurrect already exists under a new id.
  const renamedAway = "=== note {#a}\none\n===\n\n=== note {#bee}\ntwo v2\n===\n\n=== note {#c}\nthree\n===\n";
  assert.match(refused(() => revert(renamedAway, "d.geml", "#b", R("0"), ctxOf()), 1).message, /looks renamed to #bee/);
  assert.match(refused(() => revert(V2, "d.geml", "#zzz", R("0"), ctxOf()), 1).message, /exists in neither the document nor r2-tip/);
  const hist = refused(() => revert(V2, "d.geml", "#a", R("-9"), ctxOf()), 1);
  assert.equal(hist.message, "history said: matched 0 revisions for `-9`");
});
