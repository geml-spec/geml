// GEML-spec §0 (Preliminaries) and Appendix A (Diagnostic catalogue).
//
// Two things are pinned here:
//
//   1. §0.5 source normalization — encoding, BOM, line endings, U+0000 — and
//      the line-count invariant that lets blockSpans index the ORIGINAL bytes.
//   2. Appendix A — every diagnostic carries a stable code, the severity the
//      catalogue assigns, and (the drift guard) the catalogue in the published
//      spec lists exactly the codes the implementation can emit. A code added
//      to the parser without a spec row, or documented without being emitted,
//      fails here.
import { parse, blockSpans, SEVERITY } from "../dist/geml.js";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

// ---------------------------------------------------------------------------
// §0.2 — byte order mark
// ---------------------------------------------------------------------------

test("§0.2: a leading BOM is removed, so the first line still parses as itself", () => {
  const withBom = parse("﻿# Title\n");
  assert.equal(withBom.children[0].kind, "heading", "a BOM must not demote a heading to a paragraph");
  assert.equal(withBom.children[0].text, "Title");
  // The BOM-less document must be indistinguishable from the BOM-ed one.
  assert.deepEqual(withBom, parse("# Title\n"));
});

test("§0.2: a BOM is removed at a fence too, and the block keeps its id", () => {
  const doc = parse("﻿=== note {#a}\nhi\n===\n");
  assert.deepEqual(doc.ids, ["a"]);
  assert.equal(doc.diagnostics.length, 0);
});

test("§0.2: exactly ONE leading BOM is removed; a second is ordinary content", () => {
  const doc = parse("﻿﻿# Title\n");
  assert.equal(doc.children[0].kind, "paragraph", "the surviving BOM is content, so this is not a heading");
  assert.ok(doc.children[0].text.startsWith("﻿"));
});

test("§0.2: a BOM in the middle of a document is ordinary content", () => {
  const doc = parse("a﻿b\n");
  assert.equal(doc.children[0].text, "a﻿b");
});

// ---------------------------------------------------------------------------
// §0.3 — line endings
// ---------------------------------------------------------------------------

test("§0.3: CRLF, lone CR and LF all produce the identical document model", () => {
  const lf = "# T\n\n- a\n- b\n";
  const crlf = lf.replace(/\n/g, "\r\n");
  const cr = lf.replace(/\n/g, "\r");
  assert.deepEqual(parse(crlf), parse(lf), "CRLF must not change the model");
  assert.deepEqual(parse(cr), parse(lf), "a lone CR must not change the model");
});

// ---------------------------------------------------------------------------
// §0.4 — insecure characters
// ---------------------------------------------------------------------------

test("§0.4: U+0000 becomes U+FFFD and never truncates the document", () => {
  const doc = parse("a\0b\n\n# After\n");
  assert.equal(doc.children[0].text, "a�b", "NUL is replaced, not dropped");
  assert.equal(doc.children[1].kind, "heading", "content after the NUL is still parsed");
  assert.equal(doc.children[1].text, "After");
});

test("§0.4: a NUL inside a fence line cannot forge a block type", () => {
  const doc = parse("=== no\0te\nhi\n===\n");
  // `no<NUL>te` is not the `note` type: the NUL becomes U+FFFD, which the type
  // grammar (§3.1 NAME) does not admit, so this is not a fence at all.
  assert.ok(doc.children.every((b) => b.kind !== "block"), "no typed block is produced");
});

// ---------------------------------------------------------------------------
// §0.5 — the line-count invariant
// ---------------------------------------------------------------------------

test("§0.5: normalization preserves the line count, so spans index the original bytes", () => {
  // BOM + CRLF + NUL all at once: the worst case for span alignment.
  const src = "﻿# Doc\r\n\r\n=== note {#a}\r\nbo\0dy\r\n===\r\n";
  const spans = blockSpans(src);
  const span = spans.get("a");
  assert.ok(span, "the block is addressable");
  // Index the ORIGINAL source by the span's line numbers and check we land on
  // the fence — this is the property `geml get`/`set` depends on.
  const originalLines = src.split(/\r\n|\r|\n/);
  assert.match(originalLines[span.start], /^=== note \{#a\}$/, "span.start indexes the opening fence in the original bytes");
  assert.equal(originalLines[span.end - 1], "===", "span.end - 1 indexes the closing fence");
});

// ---------------------------------------------------------------------------
// Appendix A — codes, severities, and the spec/implementation drift guard
// ---------------------------------------------------------------------------

// Parse the catalogue rows out of the published spec: `| \`code\` | severity | … |`
function catalogueFromSpec(specPath) {
  const text = readFileSync(specPath, "utf8");
  const appendix = text.slice(text.indexOf("## Appendix A"));
  assert.ok(appendix, "the spec has an Appendix A");
  const rows = [...appendix.matchAll(/^\|\s*`([a-z][a-z0-9-]*)`\s*\|\s*(error|warning)\s*\|/gm)];
  return new Map(rows.map((m) => [m[1], m[2]]));
}

test("Appendix A: the spec catalogue and the implementation list exactly the same codes", () => {
  const spec = catalogueFromSpec(join(repoRoot, "spec", "GEML-spec.md"));
  const impl = new Set(Object.keys(SEVERITY));
  const undocumented = [...impl].filter((c) => !spec.has(c));
  const unimplemented = [...spec.keys()].filter((c) => !impl.has(c));
  assert.deepEqual(undocumented, [], "codes the parser can emit but Appendix A does not document");
  assert.deepEqual(unimplemented, [], "codes Appendix A documents but the parser cannot emit");
  assert.ok(impl.size >= 30, `catalogue is populated (${impl.size} codes)`);
});

test("Appendix A: every code's severity matches the spec row", () => {
  const spec = catalogueFromSpec(join(repoRoot, "spec", "GEML-spec.md"));
  for (const [code, severity] of Object.entries(SEVERITY)) {
    assert.equal(spec.get(code), severity, `severity of \`${code}\` disagrees between spec and implementation`);
  }
});

test("Appendix A: every emitted diagnostic carries a registered code and its declared severity", () => {
  // A sweep of documents chosen to fire a broad slice of the catalogue.
  const sources = [
    "=== note {#a}\nx\n===\n=== note {#a}\ny\n===\n",          // duplicate-id
    "[[#nope]] and [^ghost]\n",                                  // unresolved-reference/-footnote
    "=== note\nunclosed\n",                                      // unterminated-block
    "=== frobnicate\nbody\n===\n",                               // unknown-block-type
    "=== diagram {format=nosuch}\nbody\n===\n",                  // unknown-diagram-format
    "{{missing}}\n",                                             // unknown-metadata-reference
    // GEP-0012: the formula diagnostics are a `view`'s now — a `table` carrying
    // `compute=` would only produce `unknown-attribute`, and these three codes
    // would go unemitted, which is exactly what this walk exists to notice.
    "=== table {#t format=csv header=1}\nA\n1\n===\n=== view {src=#t compute=\"X = Y + 1\"}\n===\n", // compute-error
    "=== table {#t format=csv}\nA,B\n1,x\n===\n=== view {src=#t compute=\"C = B\"}\n===\n", // compute-non-numeric-cell
    "=== table {#t format=csv header=1}\nA,B\n1,0\n===\n=== view {src=#t compute=\"C = A / B\"}\n===\n", // compute-not-a-number
    "=== diagram {format=geml-chart}\n===\n",                    // chart-missing-data
    "[x](other.geml#y)\n",                                       // unchecked-cross-document-reference
  ];
  const seen = new Set();
  for (const src of sources) {
    for (const d of parse(src).diagnostics) {
      assert.ok(typeof d.code === "string" && d.code !== "", `diagnostic has a code: ${d.message}`);
      assert.ok(d.code in SEVERITY, `\`${d.code}\` is a registered code (${d.message})`);
      assert.equal(d.severity, SEVERITY[d.code], `\`${d.code}\` was emitted with its declared severity`);
      assert.ok(Number.isInteger(d.line) && d.line >= 1, `\`${d.code}\` carries a 1-based line`);
      seen.add(d.code);
    }
  }
  assert.ok(seen.size >= 8, `the sweep exercised a real slice of the catalogue (${seen.size} codes)`);
});

test("Appendix A: a code identifies the condition independently of the message wording", () => {
  // The contract is the code, so matching on it must not require message text.
  const doc = parse("=== note {#dup}\nx\n===\n=== note {#dup}\ny\n===\n");
  const codes = doc.diagnostics.map((d) => d.code);
  assert.deepEqual(codes, ["duplicate-id"]);
});

// ---------------------------------------------------------------------------
// §9.2 / §9.5 — limits and sinks, as the spec now states them
// ---------------------------------------------------------------------------

test("§9.2: over-deep nesting degrades to a diagnostic, never a crash", () => {
  const deep = "- a\n" + Array.from({ length: 400 }, (_, i) => " ".repeat(i + 1) + "- x").join("\n") + "\n";
  const doc = parse(deep); // must not throw RangeError
  assert.ok(doc.diagnostics.some((d) => d.code === "list-nesting-too-deep"));
  assert.equal(doc.diagnostics.find((d) => d.code === "list-nesting-too-deep").severity, "error");
});

test("§9.5: an unsafe URL scheme is neutralized in the MODEL, not at the sink", () => {
  const doc = parse("[click](javascript:alert(1))\n");
  const link = doc.children[0].inlines.find((n) => n.type === "link");
  assert.ok(link, "the link node still exists");
  assert.equal(link.href, undefined, "a javascript: destination never becomes an href in the model");
});

test("§9.5: the scheme check ignores embedded C0 characters", () => {
  for (const dest of ["java\tscript:alert(1)", "javascript:alert(1)", " javascript:alert(1)"]) {
    const doc = parse(`[click](${dest})\n`);
    const link = doc.children[0].inlines.find((n) => n.type === "link");
    assert.equal(link?.href, undefined, `\`${dest}\` must not survive as an href`);
  }
});

// Appendix B pins the SHAPE of a bare word that types as a number, and §4 the
// rule that every other bare word stays a string. coerce() is the only
// implementation of both, and the digest was narrower than it for three releases
// (no sign, no exponent, no leading dot, no leading zeros) — a grammar nobody
// checks drifts, so this checks it.
test("Appendix B: exactly the documented bare-word shapes type as a number", () => {
  const typed = (v) => {
    const doc = parse(`=== meta
k = ${v}
===

x
`);
    const meta = doc.children.find((b) => b.kind === "block" && b.type === "meta");
    return typeof meta.data.k;
  };
  for (const v of ["42", "-1", "+1", "1.5", "1.", ".5", "1e3", "1.5e-2", ".5E+2", "007"]) {
    assert.equal(typed(v), "number", `${v} types as a number`);
  }
  for (const v of ["0x10", "1e", ".", "1_000", "Infinity", "NaN", "1,5", "1-2"]) {
    assert.equal(typed(v), "string", `${v} stays a string`);
  }
});

console.log(`${passed} test(s) passed.`);
