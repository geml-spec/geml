// Security regression tests for the geml-parser core (branch sec/audit-fixes).
//
// Each test PINS the secure behavior of a landed audit fix so the hole cannot
// silently reopen, and asserts that legitimate inputs still work. Everything is
// in-process against the compiled API — EXCEPT M2 (resolver confinement), whose
// guard lives in the CLI-only `resolverFor()` (not exported), so that one drives
// a single short-lived `geml check` (as test/cli.test.mjs does; no ports).
import { parse, renderHtml } from "../dist/geml.js";
import { commit, verify } from "../dist/history.js";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, symlinkSync } from "node:fs";
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

// ===========================================================================
// ROUND 2 (branch sec/audit-fixes-r2)
// ===========================================================================

// ---------------------------------------------------------------------------
// R2-2 — control-character URL-scheme evasion (inline.ts schemeOf)
// ---------------------------------------------------------------------------
// Browsers strip leading/embedded C0 controls + spaces before acting on a URL,
// so `java\tscript:`, `\x01javascript:` and `java\nscript:` all execute as
// javascript:. schemeOf() must strip every [\x00-\x20] BEFORE matching the
// scheme so the allowlist cannot be evaded that way; http(s)/#/cross-doc/
// mailto/tel and data:image/* must still emit a working href/src.
const TAB = String.fromCharCode(9);   // literal TABs/controls are rejected by the
const NUL = String.fromCharCode(1);   // tools, so build the payloads dynamically
const STRIP_CTRL = /[\x00-\x20]/g;
// Every dangerous destination, exercised at BOTH an href sink (link) and a src
// sink (image), in one document rendered once.
const R2_2_BAD = [
  "javascript:alert(1)",
  "java" + TAB + "script:alert(1)",
  NUL + "javascript:alert(1)",
  "java\nscript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "data:text/html,<script>bad</script>",
];
const R2_2_DOC = R2_2_BAD.flatMap((d, i) => [`[l${i}](${d})`, "", `![m${i}](${d})`, ""]).join("\n");
const R2_2_HTML = renderHtml(parse(R2_2_DOC), { source: "x.geml" });

test("R2-2: control-char / obfuscated dangerous schemes never reach an href/src", () => {
  // Collect every emitted href/src, normalize the way a browser would (drop
  // [\x00-\x20], lowercase) and assert none names a script/local-read scheme.
  const sinks = [...R2_2_HTML.matchAll(/(?:href|src)="([^"]*)"/g)].map((m) => m[1]);
  for (const v of sinks) {
    const n = v.replace(STRIP_CTRL, "").toLowerCase();
    assert.ok(!n.startsWith("javascript:"), `no javascript: at a sink, got: ${JSON.stringify(v)}`);
    assert.ok(!n.startsWith("data:text/html"), `no data:text/html at a sink, got: ${JSON.stringify(v)}`);
    assert.ok(!n.startsWith("vbscript:"), `no vbscript: at a sink, got: ${JSON.stringify(v)}`);
  }
  // And the raw payloads never survive anywhere in the output.
  assert.ok(!R2_2_HTML.includes("alert(1)"), "the javascript payload was stripped");
  assert.ok(!R2_2_HTML.includes("<script>bad"), "the data:text/html script body never reaches the HTML");
});

test("R2-2: legitimate URLs, refs and image data survive with a working href/src", () => {
  const html = renderHtml(parse([
    "[ok1](https://x)", "",
    "[ok2](#a)", "",
    "[ok3](other.geml#id)", "",
    "[ok4](mailto:a@b.com)", "",
    "[ok5](tel:+15551234)", "",
    "![ok6](data:image/png;base64,iVBORw0KGgo)",
  ].join("\n")), { source: "x.geml" });
  assert.match(html, /href="https:\/\/x"/, "https kept");
  assert.match(html, /href="#a"/, "in-document anchor kept");
  assert.match(html, /href="other\.html#id"/, "cross-doc ref rewritten .geml -> .html");
  assert.match(html, /href="mailto:a@b\.com"/, "mailto: kept");
  assert.match(html, /href="tel:\+15551234"/, "tel: kept");
  assert.match(html, /src="data:image\/png;base64,iVBORw0KGgo"/, "data:image/* media kept");
});

// ---------------------------------------------------------------------------
// R2-7 — inline recursion cap (inline.ts MAX_INLINE_NESTING = 100)
// ---------------------------------------------------------------------------
// A pathologically nested link label (thousands deep) would overflow the
// parseInline<->scanAtoms recursion; the cap degrades over-deep content to text
// and emits ONE diagnostic instead of throwing a RangeError.
const inlineNestErrs = (doc) => doc.diagnostics.filter((x) => x.severity === "error" && /inline nesting too deep/.test(x.message));

test("R2-7: a 20000-deep nested link label parses to a diagnostic, never a RangeError", () => {
  let s = "x";
  for (let i = 0; i < 20000; i++) s = "[" + s + "](d)";
  let doc, threw = null;
  try { doc = parse(s); } catch (e) { threw = e; }
  assert.equal(threw, null, `parse must not throw (got ${threw && threw.name})`);
  const errs = inlineNestErrs(doc);
  assert.ok(errs.length >= 1, "parse reports an inline-nesting-too-deep error (not a stack overflow)");
  assert.match(errs[0].message, /inline nesting too deep \(max 100\)/);
  // Render must also survive the degraded model.
  const html = renderHtml(doc, { source: "x.geml" });
  assert.ok(typeof html === "string" && html.length > 0, "render returned HTML");
});

test("R2-7: a normally-nested inline parses with NO inline-nesting diagnostic", () => {
  const doc = parse("# H {#id}\n\na [**b** _c_](x) [[#id]] and `code`\n");
  assert.equal(inlineNestErrs(doc).length, 0, "no false inline-nesting diagnostic for shallow inline");
  const html = renderHtml(doc, { source: "x.geml" });
  assert.match(html, /<strong>b<\/strong>/, "emphasis inside the link label still parsed");
  assert.match(html, /<a href="x">/, "the link itself rendered");
  assert.match(html, /<code>code<\/code>/, "trailing inline code rendered");
});

// ---------------------------------------------------------------------------
// R2-8 — resolver symlink confinement (geml.ts resolverFor, CLI path)
// ---------------------------------------------------------------------------
// A symlink/junction that sits lexically INSIDE the input's subtree but points
// OUTSIDE it passes a purely lexical `..`/absolute check, yet realpathSync
// follows it to a real path outside the base. resolverFor() re-checks the REAL
// target against the REAL base and refuses the escape ("cannot resolve
// document"), while a legit in-subtree sibling still resolves. resolverFor is
// not exported, so this drives the real `geml check` once (as the M2 test does).

test("R2-8: a symlink/junction escaping the base subtree is refused; an in-subtree sibling resolves", () => {
  const root = mkdtempSync(join(tmpdir(), "geml-sec-r2-8-"));
  try {
    const base = join(root, "base");
    const outside = join(root, "outside");
    mkdirSync(base, { recursive: true });
    mkdirSync(outside, { recursive: true });
    // The escape target really exists, OUTSIDE the base subtree (id #s).
    writeFileSync(join(outside, "secret.geml"), "=== note {#s}\nsecret outside the base\n===\n");
    // A legit sibling INSIDE the subtree (id #x).
    writeFileSync(join(base, "sibling.geml"), "=== note {#x}\nchild inside the subtree\n===\n");

    // Prefer a file symlink; on Windows without privilege that throws EPERM, so
    // fall back to a directory junction (which does not require privilege). If
    // NEITHER can be created, skip — exactly like cli.test.mjs's bin-symlink test.
    let escapeRef;
    try {
      symlinkSync(join("..", "outside", "secret.geml"), join(base, "evil.geml"), "file");
      escapeRef = "evil.geml";
    } catch {
      try {
        symlinkSync(outside, join(base, "evildir"), "junction");
        escapeRef = "evildir/secret.geml";
      } catch {
        console.log("skip (symlinks unavailable)");
        return;
      }
    }

    const main = join(base, "main.geml");
    writeFileSync(main, `# Main {#top}\n\nesc [a](${escapeRef}#s)\n\nin  [b](sibling.geml#x)\n`);

    const r = spawnSync(process.execPath, ["dist/geml.js", "check", main], { encoding: "utf8", timeout: 60000 });
    const out = (r.stdout || "") + (r.stderr || "");
    // The escaping symlink is refused: confined resolver returns null -> "cannot
    // resolve document" naming the ref the author wrote.
    const escLeaf = escapeRef.replace(/\//g, "\\/");
    assert.match(out, new RegExp(`cannot resolve document \`${escLeaf}\``), "the symlink escape is refused (read confined)");
    // Confinement is not blanket denial: the in-subtree sibling still resolves.
    assert.doesNotMatch(out, /sibling\.geml/, "a legit in-subtree cross-doc ref still resolves (no error)");
    assert.match(out, /1 error\(s\)/, "exactly the one escaping ref is refused");
    assert.equal(r.status, 1, "`geml check` exits 1 (an error is present)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// R2-9 — history verify is DoS-bounded (history.ts verify incremental replay)
// ---------------------------------------------------------------------------
// verify() reconstructs every revision incrementally (one reverse patch per
// step, O(N)) rather than rebuilding each from the nearest keyframe (O(N^2)); a
// multi-hundred-revision sidecar that used to take tens of seconds now verifies
// in milliseconds. The bound is deliberately generous (CI variance) — the point
// is linear vs quadratic, not a tight number. Correctness is unchanged: it still
// re-hashes EVERY revision, so tampering one is caught at exactly that revision.
const R2_9_N = 400;
const r2_9_dir = mkdtempSync(join(tmpdir(), "geml-sec-r2-9-"));
const r2_9_geml = join(r2_9_dir, "big.geml");
const r2_9_hist = join(r2_9_dir, "big.gemlhistory");
// A document with many addressable blocks; each revision edits a rotating block
// so the reverse patch stays small yet every revision's content differs.
const R2_9_BLOCKS = 30;
const r2_9_doc = (rev) => {
  let s = "# Synthetic doc\n\n";
  for (let b = 0; b < R2_9_BLOCKS; b++) {
    const bump = b === (rev % R2_9_BLOCKS) ? `edited-at-rev-${rev} ` : "";
    s += `=== note {#b${b}}\n${bump}paragraph ${b} lorem ipsum dolor sit amet consectetur adipiscing\n===\n\n`;
  }
  return s;
};
for (let i = 0; i < R2_9_N; i++) {
  writeFileSync(r2_9_geml, r2_9_doc(i));
  commit({ gemlPath: r2_9_geml, historyPath: r2_9_hist, summary: `rev ${i}`, author: "tester", at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + i * 60000) });
}

test(`R2-9: verifying a ${R2_9_N}-revision history is fast (linear) and passes`, () => {
  const t0 = Date.now();
  const v = verify(r2_9_hist, r2_9_geml);
  const ms = Date.now() - t0;
  assert.ok(ms < 8000, `verify completed under the DoS bound (${ms}ms)`);
  assert.equal(v.ok, true, v.errors.join("; "));
  assert.equal(v.checked, R2_9_N, "every revision was reconstructed & hash-checked");
  assert.equal(v.errors.length, 0, "an intact history reports no errors");
});

test("R2-9: the fast verify still catches a tampered revision at exactly that revision", () => {
  const src = readFileSync(r2_9_hist, "utf8");
  const ids = [...src.matchAll(/=== revision \{id="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= R2_9_N, "all revision blocks present in the sidecar");
  const victim = ids[Math.floor(ids.length / 2)]; // a mid-chain revision
  // Strip ONLY that revision's recorded hash -> its reconstructed bytes no longer
  // match, every other revision is untouched.
  const tampered = src.replace(new RegExp(`(=== revision \\{id="${victim}"[^}]*?) hash="[^"]+"`), "$1");
  assert.notEqual(tampered, src, "the victim revision's hash attribute was stripped");
  const tamperedPath = r2_9_hist + ".tampered";
  writeFileSync(tamperedPath, tampered);
  const v = verify(tamperedPath);
  assert.equal(v.ok, false, "verify rejects the tampered sidecar");
  const hashErrs = v.errors.filter((e) => /reconstructed hash/.test(e));
  assert.equal(hashErrs.length, 1, "exactly one revision is flagged");
  assert.ok(hashErrs[0].includes(victim), "the flagged revision is precisely the tampered one");
  assert.equal(v.checked, R2_9_N, "verify still walks the whole chain");
  rmSync(r2_9_dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// R2-10 — table compute is DoS-bounded (table.ts aggregate memoization)
// ---------------------------------------------------------------------------
// A `sum()`/`avg()`/… aggregate over a column is constant across rows, yet the
// per-row evaluator used to rescan the whole table every row — O(R^2) per
// aggregate, so a few-thousand-row sheet with many aggregate columns took ~a
// minute. Each (fn,column) is now memoized once per formula -> O(R). Bound is
// generous (CI variance); the value produced must stay exactly correct.

test("R2-10: a 3000-row x 40-sum() compute table renders fast (linear) with the right total", () => {
  const R = 3000, M = 40;
  const formulas = Array.from({ length: M }, (_, k) => `T${k} = sum(V)`).join("; ");
  const rows = Array.from({ length: R }, () => "1").join("\n");
  const src = `=== table {#big format=csv header=1 compute="${formulas}"}\nV\n${rows}\n===\n`;
  const t0 = Date.now();
  const doc = parse(src);           // compute runs here (parse time)
  const html = renderHtml(doc, { source: "x.geml" });
  const ms = Date.now() - t0;
  assert.ok(ms < 6000, `parse+render completed under the DoS bound (${ms}ms)`);
  assert.equal(doc.diagnostics.filter((d) => d.severity === "error").length, 0, "no compute errors");
  const tbl = doc.children.find((c) => c.table).table;
  const ci = tbl.columns.indexOf("T0");
  assert.ok(ci > 0, "the T0 compute column exists");
  // sum(V) over 3000 rows of `1` is exactly 3000 — the same in every row.
  assert.equal(tbl.rows[0][ci].value, R, "first row's aggregate is correct");
  assert.equal(tbl.rows[R - 1][ci].value, R, "last row's aggregate is correct (full scan, not truncated)");
  const last = tbl.columns.indexOf(`T${M - 1}`);
  assert.equal(tbl.rows[0][last].value, R, "the last aggregate column is also correct");
});

// ---------------------------------------------------------------------------
// --root — user-widened resolver confinement (geml.ts resolverFor, CLI path)
// ---------------------------------------------------------------------------
// `geml check --root <dir>` widens the confinement base from the input's own
// directory to an ancestor the USER names on the command line — a deliberate,
// per-invocation grant that a document can never make for itself. The widened
// base is then enforced exactly as M2/R2-8 pin the default one: `..` and
// absolute escapes past the root, and symlinks whose REAL target lies outside
// it, are still refused. Web/viewer surfaces never pass a root.

test("--root: in-root ../ refs resolve and are really read; escapes past the root are still refused", () => {
  const tmp = mkdtempSync(join(tmpdir(), "geml-sec-root-"));
  try {
    const repo = join(tmp, "repo");
    mkdirSync(join(repo, "spec"), { recursive: true });
    mkdirSync(join(repo, "docs"), { recursive: true });
    // The escape target really exists, one level ABOVE the granted root.
    const secret = join(tmp, "secret.md");
    writeFileSync(secret, "# secret above the root\n");
    writeFileSync(join(repo, "README.md"), "# readme\n");
    writeFileSync(join(repo, "spec", "other.geml"), "=== note {#x}\nspec target\n===\n");
    // A drive-stripped POSIX-absolute path that path.resolve() maps back to the
    // SAME real file — the absolute case must be refused despite existing.
    const posixAbs = secret.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "");
    const main = join(repo, "docs", "main.geml");
    writeFileSync(main,
      "# Main {#top}\n\n" +
      "up   [a](../README.md)\n\n" +
      "spec [b](../spec/other.geml#x)\n\n" +
      "miss [c](../spec/other.geml#nope)\n\n" +
      "esc  [d](../../secret.md)\n\n" +
      `abs  [e](${posixAbs})\n`);

    const r = spawnSync(process.execPath, ["dist/geml.js", "check", main, "--root", repo], { encoding: "utf8", timeout: 60000 });
    const out = (r.stdout || "") + (r.stderr || "");
    // The widened base admits repo-relative refs from a sibling directory…
    assert.doesNotMatch(out, /cannot resolve document `\.\.\/README\.md`/, "../README.md resolves under --root");
    assert.doesNotMatch(out, /cannot resolve document `\.\.\/spec\/other\.geml`/, "../spec/other.geml resolves under --root");
    // …and the admitted target is REALLY read: its ids are validated.
    assert.match(out, /unresolved reference `\.\.\/spec\/other\.geml#nope`/, "anchors in the resolved doc are still checked");
    // The boundary stands at the root: `..` past it and absolute paths refused.
    assert.match(out, /cannot resolve document `\.\.\/\.\.\/secret\.md`/, "../ past the root is refused (read confined)");
    const absEsc = posixAbs.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(out, new RegExp("cannot resolve document `" + absEsc + "`"), "an absolute path is refused under --root too");
    assert.match(out, /3 error\(s\)/, "exactly the two escapes + the dangling anchor are errors");
    assert.equal(r.status, 1, "`geml check` exits 1 (errors present)");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("--root: without the flag the boundary stays the input's own directory (no silent widening)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "geml-sec-root-off-"));
  try {
    const repo = join(tmp, "repo");
    mkdirSync(join(repo, "docs"), { recursive: true });
    writeFileSync(join(repo, "README.md"), "# readme\n");
    const main = join(repo, "docs", "main.geml");
    writeFileSync(main, "# Main {#top}\n\nup [a](../README.md)\n");

    const r = spawnSync(process.execPath, ["dist/geml.js", "check", main], { encoding: "utf8", timeout: 60000 });
    const out = (r.stdout || "") + (r.stderr || "");
    assert.match(out, /cannot resolve document `\.\.\/README\.md`/, "the ../ ref is refused without an explicit --root grant");
    assert.equal(r.status, 1, "`geml check` exits 1 (an error is present)");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("--root: a symlink inside the root pointing past it is refused (R2-8 holds at the widened base)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "geml-sec-root-sym-"));
  try {
    const repo = join(tmp, "repo");
    const outside = join(tmp, "outside");
    mkdirSync(join(repo, "docs"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    // The escape target really exists, OUTSIDE the granted root (id #s).
    writeFileSync(join(outside, "secret.geml"), "=== note {#s}\nsecret outside the root\n===\n");
    // A legit target INSIDE the root, one level above the input (id #x).
    writeFileSync(join(repo, "sibling.geml"), "=== note {#x}\ninside the root\n===\n");

    // Prefer a file symlink; on Windows without privilege that throws EPERM, so
    // fall back to a directory junction. If NEITHER can be created, skip —
    // exactly like the R2-8 test above.
    let escapeRef;
    try {
      symlinkSync(join("..", "outside", "secret.geml"), join(repo, "evil.geml"), "file");
      escapeRef = "../evil.geml";
    } catch {
      try {
        symlinkSync(outside, join(repo, "evildir"), "junction");
        escapeRef = "../evildir/secret.geml";
      } catch {
        console.log("skip (symlinks unavailable)");
        return;
      }
    }

    const main = join(repo, "docs", "main.geml");
    writeFileSync(main, `# Main {#top}\n\nesc [a](${escapeRef}#s)\n\nin  [b](../sibling.geml#x)\n`);

    const r = spawnSync(process.execPath, ["dist/geml.js", "check", main, "--root", repo], { encoding: "utf8", timeout: 60000 });
    const out = (r.stdout || "") + (r.stderr || "");
    const escLeaf = escapeRef.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    assert.match(out, new RegExp(`cannot resolve document \`${escLeaf}\``), "the symlink escape past the root is refused");
    // Widening is not blanket denial: the in-root ref above the input resolves.
    assert.doesNotMatch(out, /sibling\.geml/, "an in-root ../ cross-doc ref still resolves (no error)");
    assert.match(out, /1 error\(s\)/, "exactly the one escaping ref is refused");
    assert.equal(r.status, 1, "`geml check` exits 1 (an error is present)");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Interpolation scanner (§4) — flood inputs must stay under a DoS budget.
// Brace/escape floods are linear; descending unclosed backtick runs are the
// worst case (each run's indexOf rescans the tail — same pre-existing pattern
// as scanAtoms) and must not regress catastrophically.
test("interpolation scanner: brace/escape floods and unclosed backtick runs stay under the DoS bound", () => {
  const t0 = Date.now();
  parse("{".repeat(100_000));
  parse("\\a".repeat(50_000) + "{{v}}");
  let s = "";
  for (let k = 450; k >= 1; k--) s += "`".repeat(k) + "x"; // ~100 KB of descending unclosed runs
  parse(s + "{{v}}");
  const ms = Date.now() - t0;
  assert.ok(ms < 5000, `parse completed under the DoS bound (${ms}ms)`);
});

console.log(`\n${passed} test(s) passed.`);
