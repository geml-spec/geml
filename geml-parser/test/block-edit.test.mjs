// `normalizeBlockId(src, id)` — the id-normalization primitive behind
// `geml set` (default / --head): rewrite the HEAD's id declaration of a block
// (or a bare head line) to the target id, covering EVERY head form, and leave
// everything else byte-for-byte. Pins the five id forms the set content model
// depends on. Unit-tests the compiled function directly (no CLI spawn).
import { normalizeBlockId } from "../dist/block-edit.js";
import { closeFenceLine } from "../dist/geml.js";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

// -- the five id forms -------------------------------------------------------

test("fenced attrs {#x …}: only the id changes; class/attrs ride along verbatim", () => {
  const src = "=== note {#rough .lead k=v}\nHello\n===\n";
  assert.equal(normalizeBlockId(src, "intro"), "=== note {#intro .lead k=v}\nHello\n===\n");
});

test("fenced braces WITHOUT an id: the id is inserted, keeping the class", () => {
  assert.equal(normalizeBlockId("=== note {.lead}\nB\n===\n", "t"), "=== note {#t .lead}\nB\n===\n");
});

test("fenced block with NO braces: `{#t}` is appended to the head", () => {
  assert.equal(normalizeBlockId("=== note\nB\n===\n", "t"), "=== note {#t}\nB\n===\n");
});

test("fenced EMPTY braces {}: the id fills them, no stray separator", () => {
  assert.equal(normalizeBlockId("=== note {}\nB\n===\n", "t"), "=== note {#t}\nB\n===\n");
});

test("content that is only blanks and %% comments has no head — returned byte-for-byte", () => {
  const src = "%% just a note\n\n   \n%% another\n";
  assert.equal(normalizeBlockId(src, "t"), src);
});

test("labeled close `=== #x`: BOTH the open id and the close label are rewritten", () => {
  const src = "=== note {#rough}\nbody\n=== #rough\n";
  assert.equal(normalizeBlockId(src, "t"), "=== note {#t}\nbody\n=== #t\n");
});

test("heading with explicit `{#x}` → `{#t}`", () => {
  assert.equal(normalizeBlockId("## Title {#rough}\n\nprose\n", "t"), "## Title {#t}\n\nprose\n");
});

test("heading auto-slug (no braces) → `{#t}` appended", () => {
  assert.equal(normalizeBlockId("## Setup Steps\n\nprose\n", "t"), "## Setup Steps {#t}\n\nprose\n");
});

// -- invariants --------------------------------------------------------------

test("no-op when the head id already equals the target", () => {
  const src = "=== note {#t .x}\nB\n===\n";
  assert.equal(normalizeBlockId(src, "t"), src);
});

test("only the FIRST head is touched; a nested block's id is left alone", () => {
  const src = "=== note {#rough}\nintro\n===== code {#deep}\ncode\n=====\n===\n";
  assert.equal(normalizeBlockId(src, "t"), "=== note {#t}\nintro\n===== code {#deep}\ncode\n=====\n===\n");
});

test("leading blank lines are preserved; the head below them is still normalized", () => {
  assert.equal(normalizeBlockId("\n\n=== note {#x}\nB\n===\n", "t"), "\n\n=== note {#t}\nB\n===\n");
});

test("a bare head LINE (no body) normalizes too — the --head channel", () => {
  assert.equal(normalizeBlockId("=== table {#x cap=\"D\"}\n", "t"), "=== table {#t cap=\"D\"}\n");
  assert.equal(normalizeBlockId("# Welcome\n", "t"), "# Welcome {#t}\n");
});

test("content with no recognizable head (prose) is returned unchanged", () => {
  const src = "just prose, no head here\n";
  assert.equal(normalizeBlockId(src, "t"), src);
});

test("CRLF head: the terminator is preserved, only the id changes", () => {
  assert.equal(normalizeBlockId("=== note {#x}\r\nB\r\n===\r\n", "t"), "=== note {#t}\r\nB\r\n===\r\n");
});

test("a plain close with trailing spaces still ends the block: the NEXT block's label is left alone", () => {
  // `geml set` can be handed content holding more than one block, so the close
  // scan has to stop exactly where geml.ts's own fence scan stops — and that one
  // ignores trailing spaces. Without the trim the walk runs past this block's
  // close and renames the label on a close belonging to the block after it,
  // which still declares the old id and would stop parsing.
  const src = [
    "=== note {#old}",
    "body",
    "===  ",
    "=== other {#old}",
    "more",
    "=== #old",
    "",
  ].join("\n");
  assert.equal(normalizeBlockId(src, "new"), [
    "=== note {#new}",
    "body",
    "===  ",
    "=== other {#old}",
    "more",
    "=== #old",
    "",
  ].join("\n"));
});

// --- closeFenceLine: the ONE place `--body` decides where a block ends -------
// Its own comment says why it is extracted: `get X --body | set X --body` has to
// leave the file byte-identical, and two copies of this judgement is how that
// breaks. Nothing tested it.

test("closeFenceLine: a plain close, a labeled close, and trailing spaces on either", () => {
  const plain = ["=== note {#a}", "body", "===", ""];
  assert.equal(closeFenceLine(plain, { start: 0, end: 3 }), "===");

  // A labeled close names the block's id — it closes just as much as a bare one.
  const labeled = ["=== note {#a}", "body", "=== #a", ""];
  assert.equal(closeFenceLine(labeled, { start: 0, end: 3 }), "=== #a");

  // Trailing whitespace does not stop either from being the close.
  assert.equal(closeFenceLine(["=== note {#a}", "b", "===  "], { start: 0, end: 3 }), "===  ");
  assert.equal(closeFenceLine(["=== note {#a}", "b", "=== #a  "], { start: 0, end: 3 }), "=== #a  ");
});

test("closeFenceLine: no fence, a foreign label, and a fence left open at EOF are all null", () => {
  // A heading section has no fence at all.
  assert.equal(closeFenceLine(["# H {#h}", "prose"], { start: 0, end: 2 }), null);

  // A label naming some OTHER id is not this block's close.
  assert.equal(closeFenceLine(["=== note {#a}", "b", "=== #other"], { start: 0, end: 3 }), null);

  // Unclosed at EOF: the span runs past the last line, and the answer is "none"
  // rather than the last line that happens to be there.
  assert.equal(closeFenceLine(["=== note {#a}", "body"], { start: 0, end: 5 }), null);
  assert.equal(closeFenceLine([], { start: 0, end: 0 }), null);

  // A close shorter than its opening fence does not close it.
  assert.equal(closeFenceLine(["==== note {#a}", "b", "==="], { start: 0, end: 3 }), null);
});

console.log(`\n${passed} test(s) passed.`);
