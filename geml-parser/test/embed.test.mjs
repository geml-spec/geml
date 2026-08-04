// Block transclusion — `=== embed {src=doc.geml#id}` pulls the referenced block
// in place.
//
// Design: docs/design/specs/2026-07-30-block-transclusion-design.md. Two
// decisions taken after it was written:
//
//   * The syntax is a typed BLOCK, not the `![](target)` of S1 (nor the `![[…]]`
//     that was tried first). What a transclusion selects is block content — a
//     block, a whole section, a whole document — so an inline construct is the
//     wrong shape for it: it would sit where a link goes, and expanding a section
//     mid-sentence has nowhere to go. A block also gives the attributes a home
//     and needs no new node type, so nothing that dispatches on the model has to
//     learn about it.
//   * `src=` carries the fragment (`src=other.geml#budget`), matching §0.6: a
//     fragment on a `.geml` resource denotes the block bearing that id.
//
// An older renderer degrades on its own: an unknown block type is a warning with
// the body preserved, never a broken image and never silently blank.
import { parse, serialize, gemlToMd, renderHtml } from "../dist/geml.js";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "geml.js");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

// A sibling document holding a plain block, a section with a deeper subsection,
// and a block after it — so a section boundary is observable.
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "geml-embed-"));
  writeFileSync(join(dir, "other.geml"), [
    "=== note {#budget}",
    "Thirty a month.",
    "===",
    "",
    "## Terms {#terms}",
    "",
    "Net thirty.",
    "",
    "### Fine print",
    "",
    "Rounded to the cent.",
    "",
    "## After",
    "",
    "Not part of #terms.",
    "",
  ].join("\n"));
  return dir;
}

const cli = (dir, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8" });
const embed = (src) => `=== embed {src=${src}}\n===\n`;

// ---------------------------------------------------------------------------
// The block itself
// ---------------------------------------------------------------------------

test("`=== embed {src=…}` is a known typed block, not an unknown type", () => {
  const doc = parse(embed("other.geml#budget"));
  const b = doc.children[0];
  assert.equal(b.kind, "block");
  assert.equal(b.type, "embed");
  assert.equal(b.mode, "raw", "no body to parse as flow");
  assert.equal(b.attrs["src"], "other.geml#budget");
  assert.equal(doc.diagnostics.filter((d) => d.code === "unknown-block-type").length, 0);
});

test("an embed registers its target as a reference, so it cannot rot silently", () => {
  // With no document resolver the target is reported as unchecked — which is
  // itself the proof that a reference was registered rather than ignored.
  const doc = parse(embed("other.geml#budget"));
  const d = doc.diagnostics.find((x) => x.code === "unchecked-cross-document-reference");
  assert.ok(d, `expected the target to be registered, got ${JSON.stringify(doc.diagnostics)}`);
  assert.match(d.message, /other\.geml#budget/);
});

test("an embed with no src is an error, not a silently empty block", () => {
  const doc = parse("=== embed\n===\n");
  assert.ok(doc.diagnostics.some((d) => d.code === "embed-missing-src" && d.severity === "error"),
    `expected embed-missing-src, got ${JSON.stringify(doc.diagnostics)}`);
});

test("an embed body is ignored, and says so", () => {
  const doc = parse("=== embed {src=other.geml#budget}\nstray text\n===\n");
  assert.ok(doc.diagnostics.some((d) => d.code === "ignored-embed-body"),
    `expected ignored-embed-body, got ${JSON.stringify(doc.diagnostics)}`);
});

// ---------------------------------------------------------------------------
// Validation (S6)
// ---------------------------------------------------------------------------

test("a missing id in an embed target is an error (S6)", () => {
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"), "# Host\n\n" + embed("other.geml#nope"));
  const r = cli(dir, "check", "host.geml");
  assert.equal(r.status, 1, "a rotten embed has to fail the build");
  assert.match(r.stdout + r.stderr, /unresolved reference `other\.geml#nope`/);
});

test("a missing document in an embed target is an error (S6)", () => {
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"), "# Host\n\n" + embed("gone.geml#x"));
  const r = cli(dir, "check", "host.geml");
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /cannot resolve document `gone\.geml`/);
});

test("an embed of an id that exists passes check", () => {
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"), "# Host\n\n" + embed("other.geml#budget"));
  const r = cli(dir, "check", "host.geml");
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

// ---------------------------------------------------------------------------
// Round-trip and projection
// ---------------------------------------------------------------------------

test("an embed block round-trips through the serializer", () => {
  for (const src of ["other.geml#budget", "other.geml", "#local"]) {
    const round = serialize(parse(embed(src)));
    assert.equal(serialize(parse(round)), round, "serialize(parse(x)) has to be a fixed point");
    assert.match(round, /^=== embed \{src=/);
    assert.ok(round.includes(src), `${JSON.stringify(round)} lost the target`);
  }
});

test("`--to md` projects an embed as a link to its target, with a loss note", () => {
  // Markdown has no transclusion. An empty ```embed fence — what an unknown
  // block type degrades to — tells the reader nothing at all.
  const { md, notes } = gemlToMd(parse(embed("other.geml#budget")));
  assert.doesNotMatch(md, /```embed/, "an empty fenced block says nothing");
  assert.match(md, /\[other\.geml#budget\]\(other\.geml#budget\)/);
  assert.ok(notes.some((n) => /transclus/i.test(n)), `a loss note is required, got ${JSON.stringify(notes)}`);
});

// ---------------------------------------------------------------------------
// Expansion (S2/S3) and context (S4)
// ---------------------------------------------------------------------------

test("an embed of a plain block expands that block's content in place (S2/S3)", () => {
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"), "# Host\n\n" + embed("other.geml#budget"));
  const r = cli(dir, "host.geml", "--to", "html");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Thirty a month\./, "the referenced content has to appear");
  assert.match(r.stdout, /data-src="other\.geml#budget"/, "S3: provenance on the container");
});

test("an embed of a heading id expands the whole section, at get's boundary (S2)", () => {
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"), "# Host\n\n" + embed("other.geml#terms"));
  const r = cli(dir, "host.geml", "--to", "html");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Net thirty\./, "the section's own prose");
  assert.match(r.stdout, /Rounded to the cent\./, "and its deeper subsection");
  assert.doesNotMatch(r.stdout, /Not part of #terms\./, "but nothing at or above its level");
});

test("an embed with no fragment expands the whole document (S2)", () => {
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"), "# Host\n\n" + embed("other.geml"));
  const r = cli(dir, "host.geml", "--to", "html");
  assert.equal(r.status, 0, r.stderr);
  for (const text of ["Thirty a month.", "Net thirty.", "Not part of #terms."]) {
    assert.ok(r.stdout.includes(text), `whole-document embed is missing ${JSON.stringify(text)}`);
  }
});

test("`src=#id` embeds a block of the same document", () => {
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"), "=== note {#origin}\nLocal content.\n===\n\n" + embed("#origin"));
  const r = cli(dir, "host.geml", "--to", "html");
  assert.equal(r.status, 0, r.stderr);
  assert.equal((r.stdout.match(/Local content\./g) ?? []).length, 2, "the block itself, plus the transclusion of it");
});

test("`{{key}}` in transcluded content resolves against the SOURCE document's meta (S4)", () => {
  const dir = workspace();
  writeFileSync(join(dir, "src.geml"), "=== meta\nrate = \"30\"\n===\n\n=== note {#price}\nRate is {{rate}}.\n===\n");
  writeFileSync(join(dir, "host.geml"), "=== meta\nrate = \"99\"\n===\n\n" + embed("src.geml#price"));
  const r = cli(dir, "host.geml", "--to", "html");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Rate is 30\./, "a block must mean the same thing everywhere it appears");
  assert.doesNotMatch(r.stdout, /Rate is 99\./, "the host's meta must not leak into borrowed content");
});

test("a relative target inside transcluded content is rebased to the output (S4)", () => {
  const dir = workspace();
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "peer.geml"), "=== note {#x}\nThe peer.\n===\n");
  writeFileSync(join(dir, "sub", "inner.geml"), "=== note {#i}\nSee [it](peer.geml#x).\n===\n\n" + embed("peer.geml#x"));
  writeFileSync(join(dir, "host.geml"), "# Host\n\n" + embed("sub/inner.geml#i") + "\n" + embed("sub/inner.geml"));
  const r = cli(dir, "host.geml", "--to", "html");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /sub\/peer\.(html|geml)#x/, "a link relative to the inner doc has to be rebased");
  assert.match(r.stdout, /The peer\./, "and a nested embed has to resolve through the same rebase");
});

// ---------------------------------------------------------------------------
// Recursion (S5)
// ---------------------------------------------------------------------------

test("transclusions nest: an embed inside transcluded content expands too (S5)", () => {
  const dir = workspace();
  writeFileSync(join(dir, "leaf.geml"), "=== note {#leaf}\nBottom of the chain.\n===\n");
  writeFileSync(join(dir, "mid.geml"), "=== note {#mid}\nMiddle.\n===\n\n" + embed("leaf.geml#leaf"));
  writeFileSync(join(dir, "host.geml"), "# Host\n\n" + embed("mid.geml"));
  const r = cli(dir, "host.geml", "--to", "html");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Bottom of the chain\./, "the nested embed has to expand");
});

test("two documents transcluding each other is a cycle error, and terminates (S5/S6)", () => {
  const dir = workspace();
  writeFileSync(join(dir, "a.geml"), "=== note {#a}\nA.\n===\n\n" + embed("b.geml#b"));
  writeFileSync(join(dir, "b.geml"), "=== note {#b}\nB.\n===\n\n" + embed("a.geml#a"));
  const check = cli(dir, "check", "a.geml");
  assert.equal(check.status, 1, "a cycle has to fail the build");
  assert.match(check.stdout + check.stderr, /cycle/i);
  const html = cli(dir, "a.geml", "--to", "html");
  assert.notEqual(html.status, null, "the renderer must not hang");
  assert.match(html.stdout + html.stderr, /cycle/i);
});

test("a chain deeper than the cap degrades instead of expanding forever (S5)", () => {
  const dir = workspace();
  // Whole-document embeds, so each level's own embed is inside what the level
  // above selects — a `#id` fragment would select one block and stop the chain.
  for (let i = 0; i < 12; i++) {
    const next = i < 11 ? "\n" + embed(`d${i + 1}.geml`) : "";
    writeFileSync(join(dir, `d${i}.geml`), `=== note {#d${i}}\nLevel ${i}.\n===\n${next}`);
  }
  writeFileSync(join(dir, "host.geml"), "# Host\n\n" + embed("d0.geml"));
  const r = cli(dir, "host.geml", "--to", "html");
  assert.match(r.stdout, /Level 0\./, "the shallow levels still expand");
  assert.match(r.stdout, /depth/i, "the cap has to be reported, not silently truncated");
  assert.doesNotMatch(r.stdout, /Level 11\./, "past the cap nothing expands");
});

// ---------------------------------------------------------------------------
// Regressions found in review
// ---------------------------------------------------------------------------

test("a section containing its own embed is a cycle, not 2^n copies (S5)", () => {
  // The minimal cycle. The selected slice CONTAINS the embed that selected it, so
  // expansion re-enters — and because a same-document target skipped the cycle
  // stack entirely, nothing stopped it: a 7-line document produced 256
  // transclusion containers and 33KB of output, with zero diagnostics.
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"), "# Doc\n\n## Sec {#sec}\n\nprose\n\n" + embed("#sec"));
  const chk = cli(dir, "check", "host.geml");
  assert.equal(chk.status, 1, "the minimal cycle has to fail the build");
  assert.match(chk.stdout + chk.stderr, /cycle/i);
  const html = cli(dir, "host.geml", "--to", "html");
  assert.match(html.stdout, /cycle/i, "and the renderer reports it instead of duplicating");
  const copies = (html.stdout.match(/class="transclusion"/g) ?? []).length;
  assert.ok(copies <= 1, `expected at most one container, got ${copies}`);
});

test("an indirect cycle A -> B -> C -> A is caught (S5)", () => {
  const dir = workspace();
  writeFileSync(join(dir, "a.geml"), "=== note {#a}\nA.\n===\n\n" + embed("b.geml#b"));
  writeFileSync(join(dir, "b.geml"), "=== note {#b}\nB.\n===\n\n" + embed("c.geml#c"));
  writeFileSync(join(dir, "c.geml"), "=== note {#c}\nC.\n===\n\n" + embed("a.geml#a"));
  const chk = cli(dir, "check", "a.geml");
  assert.equal(chk.status, 1, "only the direct A<->B case was covered before");
  assert.match(chk.stdout + chk.stderr, /cycle/i);
});

test("a fragment-only reference inside borrowed content resolves against its SOURCE (S4)", () => {
  // `#far` lives outside the slice. Left as `href="#far"` it is a dead link in the
  // host page — or worse, silently points at a same-named block of the host.
  const dir = workspace();
  writeFileSync(join(dir, "other2.geml"),
    "## Sec {#sec}\n\nsee [far](#far) and [[#far]]\n\n## Other {#far}\n\nthe target\n");
  writeFileSync(join(dir, "host.geml"), "# Host\n\n" + embed("other2.geml#sec"));
  const r = cli(dir, "host.geml", "--to", "html");
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /href="#far"/, "a bare fragment resolves in the wrong document");
  assert.match(r.stdout, /other2\.html#far/, "it has to point at the source document's page");
});

test("borrowed content contributes no anchors, so the page has no duplicate id (S9)", () => {
  // `check` was already right (no duplicate-id across documents) and `get`/`set`
  // were already right (a borrowed id is not addressable). The rendered HTML was
  // not: `id="dup"` appeared twice, which is invalid and makes an in-page link to
  // `#dup` browser-dependent.
  const dir = workspace();
  writeFileSync(join(dir, "src2.geml"), "=== note {#dup}\nborrowed\n===\n");
  writeFileSync(join(dir, "host.geml"), "=== note {#dup}\nhost own\n===\n\n" + embed("src2.geml#dup"));
  const chk = cli(dir, "check", "host.geml");
  assert.equal(chk.status, 0, chk.stdout + chk.stderr);
  const r = cli(dir, "host.geml", "--to", "html");
  assert.equal((r.stdout.match(/id="dup"/g) ?? []).length, 1, "the host keeps its anchor; the borrowed copy has none");
  assert.match(r.stdout, /borrowed/, "the borrowed content still renders");
});

// ---------------------------------------------------------------------------
// What a target may be, and what an inline `.geml` target means
// ---------------------------------------------------------------------------

test("an embed target that is not a GEML document is an error, not injected bytes", () => {
  // B.3 defines an embed's `src=` as a document. Nothing enforced it, so a PNG's
  // bytes were parsed as GEML and rendered as prose — a binary file would inject
  // whatever its bytes happen to look like.
  const dir = workspace();
  writeFileSync(join(dir, "photo.png"), "fake\n");
  writeFileSync(join(dir, "host.geml"), "# Host\n\n" + embed("photo.png"));
  const chk = cli(dir, "check", "host.geml");
  assert.equal(chk.status, 1, "a non-document target has to fail the build");
  assert.match(chk.stdout + chk.stderr, /photo\.png/);
  const html = cli(dir, "host.geml", "--to", "html");
  assert.doesNotMatch(html.stdout, /<p>fake<\/p>/, "the file's bytes must never reach the document");
});

test("a `.geml` target in a media embed is an error that names the block form", () => {
  // `![](other.geml#id)` used to do nothing at all: no projection, no validation,
  // no hint — the one shape where reference rot stayed silent after the block form
  // was introduced.
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"), "# Host\n\n![](other.geml#budget)\n");
  const r = cli(dir, "check", "host.geml");
  assert.equal(r.status, 1, "silence here is what the block form exists to remove");
  const out = r.stdout + r.stderr;
  assert.match(out, /other\.geml#budget/);
  assert.match(out, /=== embed/, "the message has to name the block form");
});

test("a media embed of an ordinary image is untouched", () => {
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"), "# Host\n\n![a picture](photo.png)\n");
  const r = cli(dir, "check", "host.geml");
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("an embed target outside the root is refused (fail-closed)", () => {
  const dir = workspace();
  mkdirSync(join(dir, "inner"));
  writeFileSync(join(dir, "inner", "host.geml"), "# Host\n\n" + embed("../other.geml#budget"));
  const r = cli(join(dir, "inner"), "check", "host.geml");
  assert.equal(r.status, 1, "`..` must not escape without --root");
  assert.match(r.stdout + r.stderr, /other\.geml/);
});

test("a cross-document auto-reference takes its link text from the target", () => {
  // §5.2 says an auto-ref's text comes from the target's caption/heading, and the
  // build already has a document resolver — an embed pulls whole sections through
  // it — but the cross-document form still printed the bare id.
  const dir = workspace();
  writeFileSync(join(dir, "titled.geml"), "## Section One {#sec1}\n\nbody\n");
  writeFileSync(join(dir, "host.geml"), "# Host\n\nsee [[titled.geml#sec1]]\n");
  const r = cli(dir, "host.geml", "--to", "html");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, />Section One</, "the target's heading is the link text");
});

test("`set` on an id no block declares reports the id, not the wrong flag", () => {
  // The order was reversed: prose content for a nonexistent id complained about
  // `--body` first, which reads as though the id existed.
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"), "=== note {#here}\nhi\n===\n");
  const r = spawnSync(process.execPath, [CLI, "set", "host.geml", "#far", "-o", "-"],
    { cwd: dir, encoding: "utf8", input: "just prose\n" });
  assert.notEqual(r.status, 0);
  const out = r.stdout + r.stderr;
  assert.match(out, /\bfar\b/, "the message has to name the id the author asked for");
  assert.match(out, /no block with id/, `expected the id error first, got ${JSON.stringify(out)}`);
  assert.doesNotMatch(out, /--body/, "advice about a flag implies the id exists");
});

test("`set` refuses an id that is only reachable through a transclusion", () => {
  const dir = workspace();
  writeFileSync(join(dir, "src3.geml"), "=== note {#borrowed}\nfrom elsewhere\n===\n");
  writeFileSync(join(dir, "host.geml"), "# Host\n\n" + embed("src3.geml#borrowed"));
  const r = spawnSync(process.execPath, [CLI, "set", "host.geml", "#borrowed", "--body", "-o", "-"],
    { cwd: dir, encoding: "utf8", input: "rewritten\n" });
  assert.notEqual(r.status, 0, "a borrowed id is not addressable in the host");
  assert.match(r.stdout + r.stderr, /borrowed/);
});

// ---------------------------------------------------------------------------
// S11 — history and revert belong to the source, the host stores a pointer
// ---------------------------------------------------------------------------

const geml = (dir, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8" });

test("reverting a host embed block rolls back the POINTER, not borrowed content", () => {
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"), "# Host\n\n=== embed {#emb src=other.geml#budget}\n===\n");
  geml(dir, "history", "save", "host.geml", "-m", "v1");
  // Retarget the embed, then commit that.
  writeFileSync(join(dir, "host.geml"), "# Host\n\n=== embed {#emb src=other.geml#terms}\n===\n");
  geml(dir, "history", "save", "host.geml", "-m", "v2");

  const r = geml(dir, "revert", "host.geml", "#emb", "--rev", "-1");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const back = readFileSync(join(dir, "host.geml"), "utf8");
  assert.match(back, /src=other\.geml#budget/, "the reference it used to name is what comes back");
  assert.doesNotMatch(back, /Thirty a month/, "the borrowed content is not copied into the host");
});

test("reverting an id that only exists in the source document is refused", () => {
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"), "# Host\n\n" + embed("other.geml#budget"));
  geml(dir, "history", "save", "host.geml", "-m", "v1");
  // Two revisions, so `--rev -1` is in range and the refusal is about the id
  // rather than about the offset.
  writeFileSync(join(dir, "host.geml"), "# Host\n\nprose\n\n" + embed("other.geml#budget"));
  geml(dir, "history", "save", "host.geml", "-m", "v2");
  const r = geml(dir, "revert", "host.geml", "#budget", "--rev", "-1");
  assert.notEqual(r.status, 0, "a borrowed id was never in the host's addressable space (S8)");
  assert.match(r.stdout + r.stderr, /budget/);
  assert.doesNotMatch(r.stdout + r.stderr, /out of range/, "must fail on the id, not the offset");
});

test("a source revert that strands a host reference is caught by check --root", () => {
  const dir = workspace();
  writeFileSync(join(dir, "src4.geml"), "=== note {#kept}\nfirst\n===\n\n=== note {#doomed}\nsecond\n===\n");
  writeFileSync(join(dir, "host.geml"), "# Host\n\n" + embed("src4.geml#doomed"));
  assert.equal(geml(dir, "check", "host.geml").status, 0, "sound to begin with");

  // The source loses the block the host points at.
  geml(dir, "history", "save", "src4.geml", "-m", "v1");
  writeFileSync(join(dir, "src4.geml"), "=== note {#kept}\nfirst\n===\n");

  const one = geml(dir, "check", "host.geml");
  assert.equal(one.status, 1, "the host alone already sees its own dangling target");
  const tree = geml(dir, "check", "src4.geml", "--root", ".");
  assert.equal(tree.status, 0, "the source on its own is sound — which is why the tree has to be checked");
  assert.match(one.stdout + one.stderr, /src4\.geml#doomed/);
});

// ---------------------------------------------------------------------------
// Fallback paths — every way expansion can decline, and what it leaves behind
// ---------------------------------------------------------------------------

test("with no document resolver an embed degrades to a link, saying why", () => {
  // `renderHtml` without the loadDoc/parseDoc hooks — the library path, and the
  // viewer's situation. (Not reachable through the CLI: it supplies a resolver even
  // for stdin, resolving against the working directory.) Never blank, never an
  // <img>.
  const html = renderHtml(parse(embed("other.geml#budget")), {});
  assert.match(html, /transclusion-unexpanded/, "it is marked as unexpanded");
  assert.match(html, /other\.geml#budget/, "the target stays visible");
  assert.doesNotMatch(html, /<img/, "and never reaches the media path");
});

test("`src=#id` naming nothing in this document degrades with the reason", () => {
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"), "# Host\n\n" + embed("#absent"));
  const chk = cli(dir, "check", "host.geml");
  assert.equal(chk.status, 1, "a same-document target is still a reference");
  const r = cli(dir, "host.geml", "--to", "html");
  assert.match(r.stdout, /transclusion-unresolved/);
  assert.match(r.stdout, /absent/);
});

test("an embed with no src renders as a marked block, not an empty one", () => {
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"), "# Host\n\n=== embed\n===\n");
  const r = cli(dir, "host.geml", "--to", "html");
  assert.match(r.stdout, /transclusion-invalid/);
  assert.match(r.stdout, /missing/i);
});

test("a whole-document embed skips the source's meta block", () => {
  const dir = workspace();
  writeFileSync(join(dir, "meta-src.geml"), "=== meta\ntitle = \"Source\"\n===\n\n=== note {#n}\nbody\n===\n");
  writeFileSync(join(dir, "host.geml"), "# Host\n\n" + embed("meta-src.geml"));
  const r = cli(dir, "host.geml", "--to", "html");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /body/);
  assert.doesNotMatch(r.stdout, /title = /, "frontmatter is not content");
});

test("an id inside a flow block is findable as an embed target", () => {
  const dir = workspace();
  writeFileSync(join(dir, "nested.geml"), "=== note {#outer}\n=== text {#inner}\nnested phrase\n===\n=== #outer\n");
  writeFileSync(join(dir, "host.geml"), "# Host\n\n" + embed("nested.geml#inner"));
  const r = cli(dir, "host.geml", "--to", "html");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /nested phrase/);
});

// ---------------------------------------------------------------------------
// `--root` on the transform path
// ---------------------------------------------------------------------------

// A reference that climbs out of the document's own directory needs the tree's
// root named — the same fail-closed rule `check` has. The transform accepted the
// flag and ignored it, so a document whose embeds `check --root .` validated still
// rendered with every one of them unresolved. From the outside that reads as
// "transclusion is not implemented".
function upTree() {
  const dir = mkdtempSync(join(tmpdir(), "geml-root-"));
  mkdirSync(join(dir, "tasks", "sub"), { recursive: true });
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(join(dir, "lib", "play.geml"), "=== text {#p}\nready to paste\n===\n");
  writeFileSync(join(dir, "tasks", "sub", "task.geml"),
    "# Task\n\n" + embed("../../lib/play.geml#p"));
  return dir;
}

test("a target above the document's directory resolves with `--root`, and only with it", () => {
  const dir = upTree();
  const rel = join("tasks", "sub", "task.geml");

  const closed = cli(dir, rel, "--to", "html");
  assert.doesNotMatch(closed.stdout, /ready to paste/, "fail-closed without a root");
  assert.match(closed.stderr, /cannot resolve document/);

  const open = cli(dir, rel, "--root", ".", "--to", "html");
  assert.match(open.stdout, /ready to paste/, "the content has to be inlined");
  assert.doesNotMatch(open.stderr, /cannot resolve document/);
});

test("`--root` reaches the md projection too, not just html", () => {
  const dir = upTree();
  const r = cli(dir, join("tasks", "sub", "task.geml"), "--root", ".", "--to", "md");
  assert.doesNotMatch(r.stderr, /cannot resolve document/);
});

test("a `--root` too narrow to contain the target still refuses it", () => {
  const dir = upTree();
  const r = cli(dir, join("tasks", "sub", "task.geml"), "--root", "tasks", "--to", "html");
  assert.match(r.stderr, /cannot resolve document/, "--root widens the boundary; it does not remove it");
  assert.doesNotMatch(r.stdout, /ready to paste/);
});

test("a bare `--root` is a usage error, not a silently ignored flag", () => {
  const dir = upTree();
  const r = cli(dir, join("tasks", "sub", "task.geml"), "--to", "html", "--root");
  assert.equal(r.status, 2, "the mistyped-flag exit code");
  assert.match(r.stderr, /--root needs a directory/);
});

test("an unresolvable embed degrades visibly — never a silent blank (S7)", () => {
  // The one outcome the design forbids: the node vanishing so a reader cannot tell
  // anything is missing, with the error only on stderr.
  const dir = upTree();
  const r = cli(dir, join("tasks", "sub", "task.geml"), "--to", "html");
  assert.match(r.stdout, /class="transclusion transclusion-unresolved"/, "the container is still emitted");
  assert.match(r.stdout, /\.\.\/\.\.\/lib\/play\.geml#p/, "carrying the target it could not reach");
  assert.match(r.stdout, /transclusion-note/, "and a visible reason");
});

console.log(`${passed} test(s) passed.`);
