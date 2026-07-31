// Inline projection — `![[doc.geml#id]]` renders the target block's body in place.
//
// `!` is the projection prefix, everywhere: `![](src)` projects media, `![[#id]]`
// projects content. That is what makes this the same construct in every position,
// unlike the first attempt at `![[…]]`, where a token alone on a line meant
// "embed" and the same token in a sentence meant "link" — one spelling, two
// meanings, and moving a line silently changed which you got.
//
// The physical constraint that killed that attempt has not gone away: block
// content cannot go in the middle of a sentence. It is enforced as a check on the
// TARGET's type rather than on where the reference sits, the way
// `table-source-not-a-table` is: v1 projects a `text` block whose body is a single
// paragraph, and anything else is a diagnostic.
import { parse } from "../dist/geml.js";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "geml.js");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const cli = (dir, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8" });

// A source document with one projectable phrase and several targets that are not.
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "geml-proj-"));
  writeFileSync(join(dir, "terms.geml"), [
    "=== meta",
    "product = \"Widget\"",
    "===",
    "",
    "=== text {#phrase}",
    "the *agreed* term for {{product}}, see [detail](#detail)",
    "===",
    "",
    "=== text {#two-paras}",
    "first paragraph",
    "",
    "second paragraph",
    "===",
    "",
    "=== table {#grid format=csv header=1}",
    "a,b",
    "1,2",
    "===",
    "",
    "## A heading {#detail}",
    "",
    "body of the section",
    "",
  ].join("\n"));
  return dir;
}

// ---------------------------------------------------------------------------
// It projects, in one meaning, wherever it appears
// ---------------------------------------------------------------------------

test("`![[doc.geml#id]]` in a sentence projects the target's body, not a literal !", () => {
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"), "# Host\n\nWe use ![[terms.geml#phrase]] throughout.\n");
  const r = cli(dir, "host.geml", "--to", "html");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /the <em>agreed<\/em> term/, "the body's markup has to survive");
  assert.doesNotMatch(r.stdout, /<p>We use !/, "a literal bang is the old behaviour");
  assert.match(r.stdout, /class="transclusion-inline"[^>]*data-src="terms\.geml#phrase"/, "provenance, like the block form");
});

test("a projection alone in a paragraph is still the same construct, still inline", () => {
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"), "# Host\n\n![[terms.geml#phrase]]\n");
  const r = cli(dir, "host.geml", "--to", "html");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /class="transclusion-inline"/, "position must not change the meaning");
  assert.doesNotMatch(r.stdout, /class="transclusion"[^-]/, "and it is not the block form");
});

test("`![[#id]]` projects from the document being rendered", () => {
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"),
    "=== text {#here}\na *local* phrase\n===\n\nSay ![[#here]] once.\n");
  const r = cli(dir, "host.geml", "--to", "html");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Say <span[^>]*>a <em>local<\/em> phrase<\/span> once\./);
});

// ---------------------------------------------------------------------------
// The constraint is on the TARGET's type, not on where the reference sits
// ---------------------------------------------------------------------------

for (const [what, id] of [["a heading", "detail"], ["a table", "grid"], ["a multi-paragraph body", "two-paras"]]) {
  test(`projecting ${what} is an error, because it is not inline content`, () => {
    const dir = workspace();
    writeFileSync(join(dir, "host.geml"), `# Host\n\nSee ![[terms.geml#${id}]] here.\n`);
    const r = cli(dir, "check", "host.geml");
    assert.equal(r.status, 1, "block content cannot go inside a sentence");
    const out = r.stdout + r.stderr;
    assert.match(out, new RegExp(`terms\\.geml#${id}`));
    assert.match(out, /=== embed/, "the message has to name the form that can take it");
  });
}

test("a missing target is an error, like any reference", () => {
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"), "# Host\n\nSee ![[terms.geml#gone]].\n");
  const r = cli(dir, "check", "host.geml");
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /terms\.geml#gone/);
});

// ---------------------------------------------------------------------------
// §5.3 precedence, and the escape
// ---------------------------------------------------------------------------

test("`![[#x]](y)` is a projection followed by a literal `(y)`", () => {
  const doc = parse("=== text {#x}\nphrase\n===\n\nsee ![[#x]](y) end\n");
  const para = doc.children.find((b) => b.kind === "paragraph");
  const types = para.inlines.map((n) => n.type);
  assert.ok(types.includes("project"), `expected a projection, got ${JSON.stringify(types)}`);
  assert.ok(para.inlines.some((n) => n.type === "text" && n.value.includes("(y)")),
    "the parenthesis run stays literal — the image atom must not claim it");
});

test("`\\![[#x]]` is an escaped bang plus an ordinary auto-reference", () => {
  const doc = parse("=== text {#x}\nphrase\n===\n\n\\![[#x]]\n");
  const para = doc.children.find((b) => b.kind === "paragraph");
  assert.deepEqual(para.inlines.map((n) => n.type), ["text", "autoref"]);
});

// ---------------------------------------------------------------------------
// The same transclusion machinery: cycles, source context, rebasing
// ---------------------------------------------------------------------------

test("a phrase projecting itself is a cycle, not a loop", () => {
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"), "=== text {#loop}\nsee ![[#loop]]\n===\n\nUse ![[#loop]].\n");
  const r = cli(dir, "check", "host.geml");
  assert.equal(r.status, 1, "one machinery for cycles, not a second parallel one");
  assert.match(r.stdout + r.stderr, /cycle/i);
});

test("`{{key}}` in a projected phrase resolves against the SOURCE document's meta (S4)", () => {
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"), "=== meta\nproduct = \"Other\"\n===\n\nWe sell ![[terms.geml#phrase]].\n");
  const r = cli(dir, "host.geml", "--to", "html");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /term for Widget/, "the phrase means the same thing everywhere it appears");
  assert.doesNotMatch(r.stdout, /term for Other/, "the host's meta must not leak in");
});

test("a fragment-only link inside a projected phrase resolves against its SOURCE (S4)", () => {
  // A projected phrase carrying a link is the normal case, so the fragment-only
  // rewrite matters more here than in the block form.
  const dir = workspace();
  writeFileSync(join(dir, "host.geml"), "# Host\n\nWe use ![[terms.geml#phrase]].\n");
  const r = cli(dir, "host.geml", "--to", "html");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /terms\.html#detail/, "the link points at the document the phrase came from");
  assert.doesNotMatch(r.stdout, /href="#detail"/, "a bare fragment would resolve in the host");
});

console.log(`${passed} test(s) passed.`);
