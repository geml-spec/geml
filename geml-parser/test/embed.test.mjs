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
import { parse, serialize, gemlToMd } from "../dist/geml.js";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
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

console.log(`${passed} test(s) passed.`);
