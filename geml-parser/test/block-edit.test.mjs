// `normalizeBlockId(src, id)` — the id-normalization primitive behind
// `geml set` (default / --head): rewrite the HEAD's id declaration of a block
// (or a bare head line) to the target id, covering EVERY head form, and leave
// everything else byte-for-byte. Pins the five id forms the set content model
// depends on. Unit-tests the compiled function directly (no CLI spawn).
import { normalizeBlockId } from "../dist/block-edit.js";
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

console.log(`\n${passed} test(s) passed.`);
