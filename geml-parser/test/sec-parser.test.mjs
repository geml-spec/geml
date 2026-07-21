// Security regression tests for the geml-parser core (branch sec/audit-fixes).
//
// Each test PINS the secure behavior of a landed audit fix so the hole cannot
// silently reopen, and asserts that legitimate inputs still work. Everything is
// in-process against the compiled API — EXCEPT M2 (resolver confinement), whose
// guard lives in the CLI-only `resolverFor()` (not exported), so that one drives
// a single short-lived `geml check` (as test/cli.test.mjs does; no ports).
import { parse, renderHtml } from "../dist/geml.js";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

// ---------------------------------------------------------------------------
// C1 — note class attribute XSS (render.ts classAttr)
// ---------------------------------------------------------------------------
// A `.class` token is document-author-controlled; a crafted one must not be able
// to break out of the class="" attribute and inject an event handler.

test("C1: a crafted note class cannot break out of the class attribute (XSS)", () => {
  const html = renderHtml(parse('=== note {.x" onmouseover="alert(1)}\nbody\n===\n'), { source: "x.geml" });
  const m = html.match(/<aside\b[^>]*>/);
  assert.ok(m, "note rendered as an <aside>");
  const tag = m[0];
  // No event-handler attribute reached the HTML, and the attacker payload did
  // not survive as an attribute value.
  assert.doesNotMatch(html, /onmouseover=/, "no onmouseover= attribute anywhere");
  assert.ok(!html.includes("alert(1)"), "the payload was stripped (no `alert(1)`)");
  // The class value contains ONLY safe HTML class-token characters — the crafted
  // quote / space / parens were removed by classAttr's [A-Za-z0-9_-] sanitize.
  const cls = tag.match(/class="([^"]*)"/)[1];
  assert.match(cls, /^[A-Za-z0-9_ -]*$/, `class value sanitized, got: ${cls}`);
  const tokens = cls.split(/\s+/);
  assert.ok(tokens.includes("callout"), "keeps the base `callout` class");
  assert.ok(tokens.includes("note"), "keeps the block-type `note` class");
});

test("C1: a legitimate .warning class still renders as a class token", () => {
  const html = renderHtml(parse('=== note {.warning}\nheads up\n===\n'), { source: "x.geml" });
  const cls = html.match(/<aside\b[^>]*class="([^"]*)"/)[1];
  assert.ok(cls.split(/\s+/).includes("warning"), `.warning preserved as a class, got: ${cls}`);
});

// ---------------------------------------------------------------------------
// H1 — URL scheme allowlist (inline.ts isSafeUrl / classifyDest / image src)
// ---------------------------------------------------------------------------
// javascript:, data:text/html, … at an href/src sink are script-injection /
// local-read vectors and must be neutralized at the parse layer; http(s),
// relative, anchor, cross-doc, mailto:, tel: and data:image/* must survive.
const H1_DOC = [
  "[a](javascript:alert(1))", "",
  "[b](JaVaScRiPt:alert(1))", "",
  "[c](data:text/html,<script>bad</script>)", "",
  "![i](javascript:alert(2))", "",
  "# Sec {#sec}", "",
  "[ok1](https://example.com/p)", "",
  "[ok2](foo/bar)", "",
  "[ok3](#sec)", "",
  "[ok4](other.geml#frag)", "",
  "[ok5](mailto:a@b.com)", "",
  "[ok6](tel:+15551234)", "",
  "![ok7](data:image/png;base64,iVBORw0KGgo)",
].join("\n");
const H1 = renderHtml(parse(H1_DOC), { source: "x.geml" });

test("H1: dangerous URL schemes are neutralized (no js:/data:text-html at the sink)", () => {
  assert.doesNotMatch(H1, /href="javascript:/i, "no javascript: href");
  assert.doesNotMatch(H1, /src="javascript:/i, "no javascript: src");
  assert.ok(!H1.includes("data:text/html"), "no data:text/html anywhere in the output");
  assert.ok(!H1.includes("<script>bad"), "the data:text/html script body never reaches the HTML");
  // The three script-scheme links render inert (href defaulted to `#`), text kept.
  assert.match(H1, /<a href="#">a<\/a>/, "javascript: link inert, visible text kept");
  assert.match(H1, /<a href="#">b<\/a>/, "mixed-case JaVaScRiPt: link inert");
  assert.match(H1, /<a href="#">c<\/a>/, "data:text/html link inert");
  assert.match(H1, /<img class="media" src="" alt="i">/, "javascript: image src emptied");
});

test("H1: legitimate URLs and references still produce a working href/src", () => {
  assert.match(H1, /href="https:\/\/example\.com\/p"/, "https kept");
  assert.match(H1, /href="foo\/bar"/, "relative path kept");
  assert.match(H1, /href="#sec"/, "in-document anchor kept");
  assert.match(H1, /href="other\.html#frag"/, "cross-doc ref rewritten .geml -> .html");
  assert.match(H1, /href="mailto:a@b\.com"/, "mailto: kept");
  assert.match(H1, /href="tel:\+15551234"/, "tel: kept");
  assert.match(H1, /src="data:image\/png;base64,iVBORw0KGgo"/, "data:image/* media kept");
});

// ---------------------------------------------------------------------------
// H2 — table merged-cell span clamp (table.ts + render.ts coverage sweep)
// ---------------------------------------------------------------------------
// An oversized span must be clamped to the real grid so it can neither drive an
// O(hugerows x hugecols) coverage loop nor emit an absurd rowspan/colspan.
// (A CSV table's first row is the header, so header=1 + 2 body rows gives a true
// 2x2 body grid for r1c1 to span.)

test("H2: a giant merged-cell span is clamped to the grid (prompt render, spans <= 2)", () => {
  const src = '=== table {#t format=csv header=1 span="r1c1:9999999x9999999"}\nH1, H2\na, b\nc, d\n===\n';
  const t0 = Date.now();
  const html = renderHtml(parse(src), { source: "x.geml" });
  const ms = Date.now() - t0;
  assert.ok(ms < 5000, `render completed promptly (${ms}ms)`);
  assert.ok(!html.includes("9999999"), "the oversized span value never reaches the HTML");
  for (const m of html.match(/rowspan="(\d+)"/g) || [])
    assert.ok(Number(m.match(/\d+/)[0]) <= 2, `rowspan clamped to the grid: ${m}`);
  for (const m of html.match(/colspan="(\d+)"/g) || [])
    assert.ok(Number(m.match(/\d+/)[0]) <= 2, `colspan clamped to the grid: ${m}`);
  assert.match(html, /rowspan="2"/, "clamped down to the 2 available body rows");
  assert.match(html, /colspan="2"/, "clamped down to the 2 available columns");
});

test("H2: a legitimate r1c1:2x1 span still yields the right rowspan", () => {
  const src = '=== table {#t format=csv header=1 span="r1c1:2x1"}\nH1, H2\na, b\nc, d\n===\n';
  const html = renderHtml(parse(src), { source: "x.geml" });
  assert.match(html, /<td rowspan="2">a<\/td>/, "a 2-row span is applied");
  assert.doesNotMatch(html, /colspan=/, "a 1-column span emits no colspan");
});

// ---------------------------------------------------------------------------
// M5 — nesting cap (geml.ts parser guard + render.ts depth guard)
// ---------------------------------------------------------------------------
// MAX_NESTING = 256 in BOTH parser and renderer. Input far past the cap must
// return a diagnostic (never a stack overflow) and render without a RangeError.
// The guard caps the model, so behavior is identical for any depth > 256; we use
// depths unmistakably past the cap yet fast. (20000 typed blocks is a 400MB input
// the reference parser rescans super-linearly (~100s) — a cost, not a vuln — so
// the block case uses 1000; both are ~4x-20x the cap.)
const nestedList = (d) => {
  const rows = [];
  for (let k = 0; k < d; k++) rows.push(" ".repeat(k) + "- i" + k);
  return rows.join("\n") + "\n";
};
const nestedBlocks = (d) => {
  let s = "=".repeat(d + 2) + " note\nbody\n" + "=".repeat(d + 2); // innermost = longest fence
  for (let k = d - 1; k >= 1; k--) { const f = "=".repeat(k + 2); s = f + " note\n" + s + "\n" + f; }
  return s + "\n";
};
const nestingErrs = (doc) => doc.diagnostics.filter((x) => x.severity === "error" && /nesting too deep/.test(x.message));

test("M5: deeply nested lists (5000) parse to a diagnostic and render without RangeError", () => {
  const doc = parse(nestedList(5000));
  const errs = nestingErrs(doc);
  assert.ok(errs.length >= 1, "parse reports a nesting-too-deep error (not a stack overflow)");
  assert.match(errs[0].message, /list nesting too deep \(max 256\)/);
  const html = renderHtml(doc, { source: "x.geml" }); // must not throw RangeError
  assert.ok(typeof html === "string" && html.length > 0, "render returned HTML");
});

test("M5: deeply nested typed blocks (1000) parse to a diagnostic; render bails via the guard div", () => {
  const doc = parse(nestedBlocks(1000));
  const errs = nestingErrs(doc);
  assert.ok(errs.length >= 1, "parse reports a nesting-too-deep error");
  assert.match(errs[0].message, /block nesting too deep \(max 256\)/);
  const html = renderHtml(doc, { source: "x.geml" }); // must not throw RangeError
  assert.match(html, /class="render-error">block nesting too deep/, "render depth guard fired (div, not a throw)");
});

test("M5: a normally-nested document parses and renders fully with no nesting diagnostic", () => {
  const list = parse("- a\n  - b\n    - c\n");
  assert.equal(nestingErrs(list).length, 0, "shallow list: no nesting diagnostic");
  const listHtml = renderHtml(list, { source: "x.geml" });
  assert.match(listHtml, /<ul>/, "list rendered");
  assert.ok(listHtml.includes("c"), "deepest item present");

  const blocks = parse("=== note {#o}\nouter\n\n==== note {#i}\ninner\n====\n===\n");
  assert.equal(nestingErrs(blocks).length, 0, "shallow nested blocks: no nesting diagnostic");
  const bHtml = renderHtml(blocks, { source: "x.geml" });
  assert.doesNotMatch(bHtml, /block nesting too deep/, "no render guard for a shallow document");
  assert.ok(bHtml.includes("inner"), "nested block content rendered");
});

// ---------------------------------------------------------------------------
// M2 — cross-document resolver confinement (geml.ts resolverFor, CLI path)
// ---------------------------------------------------------------------------
// resolverFor() confines cross-doc reads to the input file's subtree, so a
// crafted document cannot turn `geml check` into an arbitrary-file read oracle.
// resolverFor is not exported, so this drives the real CLI once (no ports).

test("M2: cross-doc refs escaping the base subtree are refused even though the target exists", () => {
  const root = mkdtempSync(join(tmpdir(), "geml-sec-m2-"));
  try {
    const base = join(root, "base");
    const sub = join(base, "sub");
    mkdirSync(sub, { recursive: true });
    // The escape target really exists, one level ABOVE the base subtree.
    const realOutside = join(root, "outside.geml");
    writeFileSync(realOutside, "=== note {#x}\nsecret outside the base\n===\n");
    // A legit sibling inside the subtree, referenced relatively below.
    writeFileSync(join(sub, "child.geml"), "=== note {#x}\nchild inside the subtree\n===\n");
    assert.ok(existsSync(realOutside), "the escape target really exists");
    // A drive-stripped POSIX-absolute path that path.resolve() maps back to the
    // SAME real file — so the absolute case is also refused despite existing.
    const posixAbs = realOutside.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "");
    const main = join(base, "main.geml");
    writeFileSync(main,
      "# Main {#top}\n\n" +
      "up  [a](../outside.geml#x)\n\n" +
      `abs [b](${posixAbs}#x)\n\n` +
      "in  [c](sub/child.geml#x)\n");

    const r = spawnSync(process.execPath, ["dist/geml.js", "check", main], { encoding: "utf8", timeout: 60000 });
    const out = (r.stdout || "") + (r.stderr || "");
    assert.match(out, /cannot resolve document `\.\.\/outside\.geml`/, "the ../ escape is refused (read confined)");
    assert.match(out, /cannot resolve document `[^`]*outside\.geml`/, "the absolute path is refused too");
    // Confinement is not blanket denial: the in-subtree cross-doc ref resolves.
    assert.doesNotMatch(out, /child\.geml/, "a legit in-subtree cross-doc ref still resolves (no error)");
    assert.match(out, /2 error\(s\)/, "exactly the two escaping refs are refused");
    assert.equal(r.status, 1, "`geml check` exits 1 (errors present)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\n${passed} test(s) passed.`);
