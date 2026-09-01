// Security regression tests for the geml-parser core (branch sec/audit-fixes).
//
// Each test PINS the secure behavior of a landed audit fix so the hole cannot
// silently reopen, and asserts that legitimate inputs still work. Everything is
// in-process against the compiled API — EXCEPT M2 (resolver confinement), whose
// guard lives in the CLI-only `resolverFor()` (not exported), so that one drives
// a single short-lived `geml check` (as test/cli.test.mjs does; no ports).
import { parse, renderHtml } from "../dist/geml.js";
import { save, verify } from "../dist/history.js";
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

test("H2: `span=` was withdrawn — no attribute value reaches the HTML as a cell span", () => {
  // This once clamped a giant `r1c1:9999999x9999999` to the grid, the fix for a
  // render-time blowup. The attribute is gone from §6 and the parser, so the
  // surface is gone with it — but a leftover `span=` in an old document must
  // stay INERT rather than quietly coming back as a merged cell.
  const src = '=== table {#t format=csv header=1 span="r1c1:9999999x9999999"}\nH1, H2\na, b\nc, d\n===\n';
  const t0 = Date.now();
  const html = renderHtml(parse(src), { source: "x.geml" });
  assert.ok(Date.now() - t0 < 5000, "render completed promptly");
  assert.ok(!html.includes("9999999"), "the oversized value never reaches the HTML");
  assert.doesNotMatch(html, /rowspan=|colspan=/, "a withdrawn attribute emits no span at all");
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
    // Escape EVERY regex metacharacter, not just `/` — same as the sibling case
    // below. A ref carrying a `\` (a Windows-shaped path) would otherwise land
    // in the pattern as an escape and match something else entirely.
    const escLeaf = escapeRef.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
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
  save({ gemlPath: r2_9_geml, historyPath: r2_9_hist, summary: `rev ${i}`, author: "tester", at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + i * 60000) });
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
  const ids = [...src.matchAll(/=== history-revision \{id="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= R2_9_N, "all revision blocks present in the sidecar");
  const victim = ids[Math.floor(ids.length / 2)]; // a mid-chain revision
  // Strip ONLY that revision's recorded hash -> its reconstructed bytes no longer
  // match, every other revision is untouched.
  const tampered = src.replace(new RegExp(`(=== history-revision \\{id="${victim}"[^}]*?) hash="[^"]+"`), "$1");
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

// ===========================================================================
// ROUND 3 (branch claude/gemi-viewer-parser-security-h54fl5)
// ===========================================================================

// ---------------------------------------------------------------------------
// R3-F1 — a block id is any non-whitespace run (§4) and was interpolated raw
// into the labeled-close RegExp on the main parse path; a crafted id threw an
// uncaught SyntaxError or caused a ReDoS. Ids must be regex-escaped (reLit).
// ---------------------------------------------------------------------------

test("R3-F1: crafted block ids never crash the parser or cause ReDoS (RegExp injection)", () => {
  const t0 = Date.now();
  for (const id of ["a(", "(x+x+)+y", "a{2,}", "a|b", "[a-", "a\\", ".*", "^$"]) {
    const d = parse(`=== code {#${id}}\nhello\n===\n`);
    assert.ok(Array.isArray(d.children), `parsed without throwing for id #${id}`);
  }
  // A catastrophic-backtracking id with a matching-looking body line stays linear.
  parse("=== code {#(x+x+)+y}\n=== #" + "x".repeat(40) + "\nbody\n===\n");
  const ms = Date.now() - t0;
  assert.ok(ms < 3000, `crafted-id parses stayed under the DoS bound (${ms}ms)`);
});

test("R3-F1: a normal id still closes on its labeled fence and both blocks survive", () => {
  const d = parse("=== code {#snip}\nA\n=== #snip\n\n=== code {#after}\nB\n===\n");
  assert.ok(d.ids.includes("snip") && d.ids.includes("after"), "both ids registered");
  const snip = d.children.find((b) => b.id === "snip");
  assert.deepEqual(snip.raw, ["A"], "labeled close consumed — body is just `A`");
});

// ---------------------------------------------------------------------------
// R3-F3 — the line scanners were polynomial. Every head form ended in
// `…[ \t]*(\{…\})?[ \t]*$`: when the optional group is absent, two whitespace
// runs compete for the same characters and the engine tries every division of
// them. The heading form was worse still — a LAZY `(.*?)` in front of the two
// runs made it cubic. Measured before the fix, on ONE line:
//     `=== note` + 8k tabs + `{`   ->  84 s   (FENCE_SEL, selector.ts)
//     `# T`      + 8k tabs + `{`   ->  84 s   (HEADING, geml.ts)
//     `# T`      + 4k tabs + `{`   ->  10.5 s (doubling the tabs x8 the time)
// An 8 KB line is a denial-of-service payload against anything that parses an
// untrusted document, which is the parser's whole job. Fixed by nesting the
// trailing run inside the optional group (fences) and by scanning instead of
// matching (headings). These bound the WHOLE document parse, so they fail on a
// regression in any one of the scanners.
// ---------------------------------------------------------------------------

test("R3-F3: a near-miss whitespace flood in every head form parses in linear time", () => {
  // TWO sizes, because the two regressions have different exponents and one
  // size cannot fail cleanly on both. 3k trips a CUBIC heading (~4 s) while a
  // quadratic fence is still only milliseconds; 60k trips a QUADRATIC fence
  // (~5 s) while a cubic heading would not fail, it would HANG. Linear is under
  // a millisecond at either size, so the 3 s bar never flakes.
  const heads = ["=== note", "# T", "## Deep", "=== code", "#### x"];
  for (const n of [3_000, 60_000]) {
    const pad = "\t".repeat(n);
    for (const head of heads) {
      // A valid head prefix, a long run of tabs, then one byte that DENIES the
      // match — the shape that made the engine explore every split of the run.
      const line = `${head}${pad}{`;
      const t0 = Date.now();
      parse(line + "\n");
      const ms = Date.now() - t0;
      assert.ok(ms < 3000, `a ${n / 1000}k whitespace flood after ${JSON.stringify(head)} took ${ms} ms — a head scanner is backtracking again`);
    }
  }
});

test("R3-F3: the rewritten head scanners still read every legitimate head", () => {
  // The fix changed HOW these match, so pin WHAT they match. The brace rules are
  // the subtle part: `{…}` may contain `{`, and the lazy text took the FIRST
  // brace that still reached the end of the line — not the last.
  const d = parse([
    "# Plain",
    "",
    "## Titled {#sec .cls}",
    "",
    "### Spaced   {#sp}   ",
    "",
    "#### Brace} in text {#br}",
    "",
    "=== code {#c lang=js}",
    "x",
    "===",
    "",
  ].join("\n"));
  const heads = d.children.filter((b) => b.kind === "heading");
  assert.deepEqual(heads.map((h) => h.text), ["Plain", "Titled", "Spaced", "Brace} in text"],
    "heading text stops before the attrs brace and keeps a `}` that is part of the text");
  // `Plain` carries no attrs, so its id is the slug of its text — proof the
  // scanner handed the WHOLE line to the text, with no phantom attrs group.
  assert.deepEqual(heads.map((h) => h.id), ["plain", "sec", "sp", "br"], "ids come off the attrs object, or the slug when there is none");
  assert.ok(heads[1].classes.includes("cls"), "classes survive too");
  const code = d.children.find((b) => b.type === "code");
  assert.equal(code.id, "c", "the fence head still yields its id");
  assert.equal(code.attrs.lang, "js", "and its attrs");
  const errs = d.diagnostics.filter((x) => x.severity === "error");
  assert.equal(errs.length, 0, `no errors: ${JSON.stringify(errs)}`);
});

test("R3-F3: a heading whose text ENDS in a brace group is still attrs, not text", () => {
  // `# a}b{c}` — the last `}` inside the text forces the group to start at the
  // `{` after it. Getting this backwards silently moves bytes between the two.
  const d = parse("# a}b{#c}\n");
  const h = d.children.find((b) => b.kind === "heading");
  assert.equal(h.text, "a}b", "text keeps its own closing brace");
  assert.equal(h.id, "c", "and the trailing group is read as attrs");
});

// ---------------------------------------------------------------------------
// R3-F2 — `set --body` on a typed block assembled head+body+close, so a `===`
// fence in the raw body closed the block early and injected sibling blocks.
// ---------------------------------------------------------------------------

test("R3-F2: set --body cannot inject a sibling block via a fence in the raw body", () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-sec-r3f2-"));
  try {
    const f = join(dir, "doc.geml");
    const original = "=== code {#snippet lang=py}\nprint(0)\n===\n";
    writeFileSync(f, original);
    const body = 'print(1)\n===\n\n=== meta\nbrand="INJECTED"\n===\n';
    const r = spawnSync(process.execPath, ["dist/geml.js", "set", f, "#snippet", "--body", "--in", "-"],
      { input: body, encoding: "utf8", timeout: 60000 });
    assert.equal(r.status, 1, "the injecting set is refused");
    assert.match((r.stderr || "") + (r.stdout || ""), /block count/i, "refusal cites the block-count guard");
    assert.equal(readFileSync(f, "utf8"), original, "the document is left byte-identical");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("R3-F2: set --body still swaps a legitimate body in place", () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-sec-r3f2b-"));
  try {
    const f = join(dir, "doc.geml");
    writeFileSync(f, "=== code {#snippet lang=py}\nprint(0)\n===\n");
    const r = spawnSync(process.execPath, ["dist/geml.js", "set", f, "#snippet", "--body", "--in", "-"],
      { input: "print(42)\n", encoding: "utf8", timeout: 60000 });
    assert.equal(r.status, 0, "a normal body swap succeeds");
    const out = readFileSync(f, "utf8");
    assert.match(out, /print\(42\)/, "new body written");
    assert.match(out, /#snippet/, "id preserved");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// R3-F3 — rename `#foo` also rewrote the DIFFERENT id `#foo.bar` (`.` looked
// like a boundary). runRename must refuse when any other id would change.
// ---------------------------------------------------------------------------

test("R3-F3: rename refuses when it would also change a different id sharing the prefix", () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-sec-r3f3-"));
  try {
    const f = join(dir, "dot.geml");
    const original = "=== code {#foo}\na\n===\n\n=== code {#foo.bar}\nb\n===\n";
    writeFileSync(f, original);
    const r = spawnSync(process.execPath, ["dist/geml.js", "rename", f, "#foo", "#baz"],
      { encoding: "utf8", timeout: 60000 });
    assert.equal(r.status, 1, "collateral rename refused");
    assert.equal(readFileSync(f, "utf8"), original, "document left byte-identical");
    assert.match(readFileSync(f, "utf8"), /#foo\.bar/, "the sibling id is untouched");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("R3-F3: a rename with no id collision still rewrites the declaration and its reference", () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-sec-r3f3b-"));
  try {
    const f = join(dir, "ok.geml");
    writeFileSync(f, "# Title {#foo}\n\nsee [[#foo]]\n");
    const r = spawnSync(process.execPath, ["dist/geml.js", "rename", f, "#foo", "#baz"],
      { encoding: "utf8", timeout: 60000 });
    assert.equal(r.status, 0, "clean rename succeeds");
    const out = readFileSync(f, "utf8");
    assert.match(out, /#baz/, "declaration renamed");
    assert.ok(!out.includes("#foo"), "the #foo reference was rewritten (none left)");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Resolver robustness — the confinement must FAIL CLOSED (return "unresolvable")
// on anything it cannot read, never crash `geml check`. A crafted document
// chooses the ref target, so every rejection path is attacker-reachable.
// ---------------------------------------------------------------------------

test("resolver: a ref whose target is unreadable (a directory wearing the name) is refused, not a crash", () => {
  const root = mkdtempSync(join(tmpdir(), "geml-sec-res-"));
  try {
    const base = join(root, "base");
    mkdirSync(join(base, "dir.geml"), { recursive: true }); // a DIRECTORY named like a doc
    const main = join(base, "main.geml");
    writeFileSync(main, "# M {#t}\n\nref [a](dir.geml#x)\n");
    const r = spawnSync(process.execPath, ["dist/geml.js", "check", main], { encoding: "utf8", timeout: 60000 });
    const out = (r.stdout || "") + (r.stderr || "");
    // The wording moved when links to directories stopped being broken links:
    // this target EXISTS, so the accurate complaint is about the anchor, not
    // about resolving the document. The invariant this test is here for — fail
    // closed, cleanly, on a target chosen by a crafted document — is unchanged.
    assert.match(out, /unresolved reference `dir\.geml#x`/, "an unreadable target is reported, not thrown");
    assert.doesNotMatch(out, /EISDIR|ENOTDIR|Error:|at .*geml\.js:/, "no raw exception / stack trace leaked");
    assert.equal(r.status, 1, "exits 1 with the diagnostic (clean failure)");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// The "never throw on a crafted document" contract (the invariant behind R2-7
// and R3-F1): parse() must always return a model + diagnostics. These are the
// structural edge cases most likely to reach an unguarded index/regex.
// ---------------------------------------------------------------------------

// §9.1 — documents are data, never code. This is the family that produced
// `yaml.load` vs `safe_load`, SnakeYAML gadget chains, fastjson's `@type`, .NET
// TypeNameHandling and Python pickle: in every one of them the DATA got to say
// what the runtime should instantiate or execute. GEML is immune because
// `coerce()` has exactly five outcomes and none of them is "a type the document
// named" — but immunity by omission is invisible, and the next person to add a
// convenience ("let a value declare its type") would remove it without a single
// test going red. These tests are that test.
test("§9.1: a meta value can only become a string, a number or a boolean", () => {
  const doc = parse([
    "=== meta",
    'quoted = "5"',
    "int = 42",
    "float = 1.5",
    "yes = true",
    "no = false",
    "bare = hello",
    "===",
    "",
    "x",
  ].join("\n"));
  const meta = doc.children.find((b) => b.kind === "block" && b.type === "meta");
  const kinds = Object.fromEntries(Object.entries(meta.data).map(([k, v]) => [k, typeof v]));
  assert.deepEqual(kinds, {
    quoted: "string", int: "number", float: "number",
    yes: "boolean", no: "boolean", bare: "string",
  });
  // Not merely "these six are scalars" — NOTHING in the map may be an object or
  // a function, which is what a type-tag feature would introduce.
  for (const [k, v] of Object.entries(meta.data)) {
    assert.ok(["string", "number", "boolean"].includes(typeof v), `${k} is ${typeof v}`);
    assert.ok(v === null || typeof v !== "object", `${k} must not be an object`);
  }
});

test("§9.1: type-tag syntax borrowed from YAML or fastjson stays literal text", () => {
  // Each of these is a real payload shape from the family. GEML must read every
  // one as a STRING — no class loading, no constructor, no JNDI lookup.
  const payloads = {
    py: "!!python/object/apply:os.system",
    java: "!!javax.script.ScriptEngineManager",
    // fastjson's marker without its surrounding JSON quotes: a `"` inside a
    // quoted attribute value is a separate, already-tracked gap (attrs.ts has no
    // `\"` unescape), and mixing it in here would test that instead of this.
    fastjson: "@type:com.sun.rowset.JdbcRowSetImpl",
    dotnet: "$type:System.Diagnostics.Process",
    ruby: "!ruby/object:Gem::Requirement",
  };
  const src = "=== meta\n"
    + Object.entries(payloads).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join("\n")
    + "\n===\n\nx\n";
  const doc = parse(src);
  const meta = doc.children.find((b) => b.kind === "block" && b.type === "meta");
  for (const [k, v] of Object.entries(payloads)) {
    assert.equal(typeof meta.data[k], "string", `${k} must stay a string`);
    assert.equal(meta.data[k], v, `${k} must be preserved verbatim, not interpreted`);
  }
  assert.equal(doc.diagnostics.filter((d) => d.severity === "error").length, 0,
    "…and it is ordinary content, not an error — the payload is only dangerous to a processor that interprets it");
});

test("§9.1: an unquoted attribute value cannot become anything but a scalar either", () => {
  // The same coercion feeds block attributes, where a value reaches `src=`,
  // `data=` and `format=` — every place a processor acts on document text.
  const doc = parse('=== note {#n level=3 flag=true name=plain other="!!python/object"}\nbody\n===\n');
  const b = doc.children.find((x) => x.kind === "block" && x.type === "note");
  assert.deepEqual(
    Object.fromEntries(Object.entries(b.attrs).map(([k, v]) => [k, typeof v])),
    { level: "number", flag: "boolean", name: "string", other: "string" },
  );
});

test("parse never throws on structurally hostile documents (fences, attrs, tables, refs)", () => {
  const hostile = [
    "===",                                        // bare close, no open
    "=== code",                                   // open, never closed
    "=== code {#a}\n=== #b\n",                    // labeled close naming a DIFFERENT id
    "=== table {#t format=csv compute=\"X = @@@\"}\nA, B\n1, 2\n===",  // bad formula
    "=== table {#t2 format=csv summary=\"A = @@@\"}\nA, B\n1, 2\n===", // bad summary
    "=== table {#t3 format=csv compute=\"X = bogus(A)\"}\nA, B\n1, 2\n===", // unknown fn
    "=== meta\n= = =\n===",                       // malformed meta body
    "{#}\n",                                      // empty id token
    "=== code {#a} {#b}\nx\n===",                 // two attr objects
    "# H {#dup}\n\n=== note {#dup}\nx\n===",      // duplicate id
    "[a](",                                        // unbalanced link
    "[[#",                                         // unterminated autoref
    "[^",                                          // unterminated footnote
    "|a|b|\n|-",                                   // truncated md-ish table
  ];
  for (const src of hostile) {
    const d = parse(src);
    assert.ok(d && Array.isArray(d.children), `parse returned a model for: ${JSON.stringify(src.slice(0, 30))}`);
    assert.ok(Array.isArray(d.diagnostics), "diagnostics array present");
  }
});

test("renderHtml never throws on the same hostile documents (and injects no author script)", () => {
  // The CLI page legitimately inlines its OWN <script> (table sort / code-graph
  // runtime). What must never appear is a script the DOCUMENT supplied, or any
  // remote script src (the extension bundle is scanned for that separately).
  const payload = '<script>alert(1)</script>';
  for (const src of ["===", "=== code", "{#}\n", "[a](", "[[#", "=== code {#a}\n=== #b\n", `# H {#i}\n\n${payload}\n`]) {
    const html = renderHtml(parse(src), { source: "x.geml" });
    assert.equal(typeof html, "string", "rendered to a string");
    assert.doesNotMatch(html, /<script[^>]+src=/i, "no remote script src emitted");
    assert.ok(!html.includes(payload), "a document-supplied <script> is escaped, never emitted raw");
  }
});

// ===========================================================================
// ROUND 4 (inline audit after 1.8.0 — emphasis pairs across inline atoms)
// ===========================================================================

// ---------------------------------------------------------------------------
// R4-1 — emphasis pairing must stay LINEAR (inline.ts processEmphasis)
// ---------------------------------------------------------------------------
// `bottom` exists to bound the opener search, but it recorded `closer.prev` — a
// node of the MAIN list, normally a text or atom node — while the search walked
// only delimiters. The sentinel could therefore never be reached, so every
// closer that found no opener re-walked the entire prefix: quadratic. Measured
// before the fix, at the document level:
//     "a* ".repeat(30000)   (88 KB)  ->  4.7 s
//     "a~~ ".repeat(30000)  (117 KB) ->  3.0 s
//     "*a".repeat(30000)    (59 KB)  ->  0.9 s
// i.e. ~25 s for a single 200 KB paragraph, from any untrusted document. The fix
// threads the delimiters onto their own chain (so the walk steps delimiter to
// delimiter) and records the bound as a delimiter POSITION, which stays valid
// after the delimiter it names is consumed. All of these are now milliseconds;
// the bar is deliberately generous, since what it pins is linear vs quadratic.
test("R4-1: 200 KB of pathological delimiter runs parses in linear time", () => {
  const payloads = [
    "a* ".repeat(70_000),        // close-only `*` runs: never an opener, always searched
    "a~~ ".repeat(50_000),       // the same for `~~`
    "a*. ".repeat(50_000),       // punctuation flanking kills `open`, keeps `close`
    "*a".repeat(100_000),        // pairs immediately, but every second run fails first
    "`c`* ".repeat(40_000),      // atoms between the delimiters (1.8.0's new shape)
    "![a](b)* ".repeat(22_000),  // …media atoms too
    "*[x](y)".repeat(25_000),    // a delimiter run on each side of a link atom
    "*\\*".repeat(100_000),      // escaped punctuation is its own atom, interleaved
  ];
  for (const src of payloads) {
    const t0 = Date.now();
    const doc = parse(src);
    const ms = Date.now() - t0;
    assert.ok(ms < 5000, `${(src.length / 1024).toFixed(0)} KB of delimiter runs took ${ms} ms — the opener search is unbounded again`);
    assert.ok(Array.isArray(doc.children), "parse returned a model");
  }
});

test("R4-1: ordinary emphasis, strong and strike still pair (the bound is not a wall)", () => {
  const doc = parse("a *em* b **st** c ~~del~~ d ***both*** e *[l](x)* f\n");
  const html = renderHtml(doc, { source: "x.geml" });
  assert.match(html, /<em>em<\/em>/, "emphasis pairs");
  assert.match(html, /<strong>st<\/strong>/, "strong pairs");
  assert.match(html, /<del>del<\/del>/, "strike pairs");
  assert.match(html, /<em><strong>both<\/strong><\/em>|<strong><em>both<\/em><\/strong>/, "a 3-run pairs as both");
  assert.match(html, /<em><a href="x">l<\/a><\/em>/, "emphasis still pairs ACROSS a link atom (GEP-0007)");
});

// ---------------------------------------------------------------------------
// R4-2 — a `~` run of three or more must not hang or throw (inline.ts)
// ---------------------------------------------------------------------------
// `use` was 2 unconditionally for `~`, but a run can be left with ONE character
// after a first pairing. Pairing it again took `n` past zero, and since the loop
// only advances when `n === 0`, the same closer was re-paired forever, allocating
// a wrap node each time: `~~~a~~~` — seven bytes — hung the parser outright, with
// memory climbing. Where the closer did land on 0 while the opener went negative,
// finalize reached `"~".repeat(-1)` and parse threw an uncaught RangeError
// (`~~~~a~~~`). Both break §9's "a crafted document is data, never a crash"
// contract from any input path: `geml check`, the MCP server, the viewer.
//
// Driven in a CHILD process so a regression FAILS on the timeout instead of
// hanging this suite for ever.
const R4_2_CASES = ["~~~a~~~", "~~~~a~~~", "~~~x~~~y~~~", "~~~a~~b~~~", "~~~~~a~~~~~", "~~~", "a~~~b~~~c"];
const R4_2_DIST = new URL("../dist/geml.js", import.meta.url).href;

test("R4-2: a `~` run of 3+ neither hangs nor throws, and its leftover stays literal", () => {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
const { parse } = await import(${JSON.stringify(R4_2_DIST)});
const out = {};
for (const s of ${JSON.stringify(R4_2_CASES)}) out[s] = parse(s + "\\n").children[0].inlines;
process.stdout.write(JSON.stringify(out));
`], { encoding: "utf8", timeout: 30000 });
  assert.equal(child.signal, null, "the child was NOT killed — a `~~~` run no longer loops for ever");
  assert.equal(child.status, 0, `parse must not throw: ${(child.stderr || "").split("\n").slice(0, 3).join(" ")}`);
  const got = JSON.parse(child.stdout);

  // A run with one character left over is not a delimiter (a lone `~` never was),
  // so it stays literal text — exactly what `~~~a~~` and `~~a~~~` already did.
  assert.deepEqual(got["~~~a~~~"], [
    { type: "text", value: "~" },
    { type: "strike", children: [{ type: "text", value: "a" }] },
    { type: "text", value: "~" },
  ], "`~~~a~~~` is one strike between two literal tildes");
  assert.deepEqual(got["~~~~a~~~"], [
    { type: "text", value: "~~" },
    { type: "strike", children: [{ type: "text", value: "a" }] },
    { type: "text", value: "~" },
  ], "`~~~~a~~~` spends two on the strike and keeps the rest literal");
  // Nothing vanishes: every `~` is either a delimiter that paired or literal text.
  for (const [src, inlines] of Object.entries(got)) {
    const count = (x) => JSON.stringify(x).split("~").length - 1;
    const kept = count(inlines) + 2 * JSON.stringify(inlines).split('"strike"').length - 2;
    assert.ok(kept >= 0 && count(inlines) <= (src.match(/~/g) || []).length,
      `no tilde is invented for ${JSON.stringify(src)}`);
  }
  assert.equal(got["~~~"].length, 1, "a bare run pairs with nothing");
  assert.deepEqual(got["~~~"][0], { type: "text", value: "~~~" }, "…and is literal text");
});

// ---------------------------------------------------------------------------
// R4-3 — the atom scanner must stay LINEAR (inline.ts scanAtoms)
// ---------------------------------------------------------------------------
// readBracket/readParen counted depth FORWARD from the opener on every construct
// tried, so each position that fails to be a link/image/auto-reference/footnote
// rescanned the whole tail. Measured before the fix, on parseInline alone:
//     "[[".repeat(80000)   (160 KB) -> 39.8 s   (tries the `[[…]]` form, then the link form)
//     "[^".repeat(80000)   (160 KB) -> 23.8 s
//     "![".repeat(80000)   (160 KB) -> 22.3 s
//     "[a](".repeat(80000) (320 KB) -> 20.7 s
//     "[".repeat(80000)    ( 80 KB) ->  9.0 s
// The partner of every `[`/`(` is now computed in ONE stack pass, shared by every
// nesting level through an offset, so a failed construct costs O(1). Same bound,
// same reason as R4-1: linear vs quadratic, not a tight number.
test("R4-3: 200 KB of bracket/paren floods parses in linear time", () => {
  const payloads = [
    "[[".repeat(100_000),   // auto-reference form tried, then the link form
    "![".repeat(100_000),   // media form
    "[^".repeat(100_000),   // footnote form
    "[a](".repeat(50_000),  // label matches, destination never closes
    "[".repeat(100_000),    // nothing closes at all
    "[a](b)".repeat(30_000),// …and the shape that DOES match, for contrast
  ];
  const t0 = Date.now();
  for (const src of payloads) parse(src);
  const ms = Date.now() - t0;
  assert.ok(ms < 5000, `bracket/paren floods took ${ms} ms — a construct scanner is rescanning the tail again`);
});

test("R4-3: every inline construct still reads its span (the shared pair map is exact)", () => {
  const doc = parse([
    "# Sec {#sec}", "",
    "[lab](https://e.com/p) ![alt](pic.png) [[#sec]] [^fn]", "",
    "nested [a[b]c](d.geml#sec) and dest parens [x](https://e.com/a(b)c)", "",
    "attrs [y](https://e.com){rel=\"noopener\"} and ![z](pic.png){as=\"image\"}", "",
    "=== text {#inl}", "projected sentence", "===", "",
    "projection ![[#inl]] here", "",
    "=== text {#fn}", "footnote body", "===",
  ].join("\n"));
  const html = renderHtml(doc, { source: "x.geml" });
  assert.match(html, /<a href="https:\/\/e\.com\/p">lab<\/a>/, "link label and destination");
  assert.match(html, /<img class="media" src="pic\.png" alt="alt">/, "image");
  assert.match(html, /<a href="#sec">Sec<\/a>/, "auto-reference takes the heading's text");
  assert.match(html, /class="fn"/, "footnote reference");
  assert.match(html, /href="d\.html#sec">a\[b\]c</, "a bracket INSIDE a label stays in the label");
  assert.match(html, /href="https:\/\/e\.com\/a\(b\)c"/, "balanced parens inside a destination stay in it");
  assert.match(html, /rel="noopener"/, "trailing attrs still attach");
  assert.match(html, /transclusion-inline/, "the inline projection expanded");
  assert.ok(html.includes("projected sentence"), "…with the target's content");
  assert.equal(doc.diagnostics.filter((d) => d.severity === "error").length, 0,
    `no errors: ${JSON.stringify(doc.diagnostics)}`);
});

// ---------------------------------------------------------------------------
// R4-4 — a block type is document text, so the registry cannot be a plain object
// ---------------------------------------------------------------------------
// `REGISTRY[type]` answered for the whole prototype chain: `=== constructor`
// (and toString, valueOf, hasOwnProperty, isPrototypeOf, propertyIsEnumerable,
// toLocaleString) returned an inherited FUNCTION. Not undefined, so the
// unknown-block-type warning never fired — a document could name a type
// `geml check` accepted in silence — and that function was stored as the block's
// `mode`, a value the published `BodyMode` type says cannot occur and one
// JSON.stringify drops without a word. REGISTRY is a Map now, like every other
// document-keyed registry in the parser.
const PROTO_NAMES = ["constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString"];

test("R4-4: a prototype-chain name as a block type warns like any unknown type", () => {
  for (const name of PROTO_NAMES) {
    const doc = parse(`=== ${name} {#x}\nbody\n===\n`);
    const b = doc.children.find((x) => x.kind === "block");
    assert.ok(b, `${name} parsed as a typed block`);
    assert.equal(typeof b.mode, "string", `${name}: mode must be a string, got ${typeof b.mode}`);
    assert.equal(b.mode, "raw", `${name}: an unknown type keeps its body raw`);
    const codes = doc.diagnostics.map((d) => d.code);
    assert.ok(codes.includes("unknown-block-type"), `${name}: the unknown-type warning fires (got ${JSON.stringify(codes)})`);
    // …and the model stays JSON-round-trippable (a function silently vanishes).
    assert.equal(JSON.parse(JSON.stringify(b)).mode, "raw", `${name}: mode survives JSON`);
    renderHtml(doc, { source: "x.geml" }); // must not throw
  }
});

test("R4-4: the registered types still resolve to their own body mode", () => {
  const modes = {};
  for (const t of ["note", "text", "meta", "code", "table", "data", "embed", "math", "diagram"]) {
    const doc = parse(`=== ${t} {#x}\nbody\n===\n`);
    const b = doc.children.find((x) => x.kind === "block");
    modes[t] = b.mode;
    assert.ok(!doc.diagnostics.some((d) => d.code === "unknown-block-type"), `${t} is a registered type`);
  }
  assert.equal(modes.note, "flow", "note is flow");
  assert.equal(modes.text, "flow", "text is flow");
  assert.equal(modes.meta, "data", "meta is data");
  assert.equal(modes.code, "raw", "code is raw");
});

// ---------------------------------------------------------------------------
// R4-5 — prototype pollution through document-controlled KEYS
// ---------------------------------------------------------------------------
// `__proto__`, `constructor` and friends are ordinary text in a `=== meta` body,
// an attribute object and a `{{…}}` reference — all three land in structures the
// document names the keys of. Nothing there may reach Object.prototype, become a
// non-scalar, or make a lookup answer for something the document never wrote.
// (`coerce` only ever yields string/number/boolean, so an assignment to
// `__proto__` is a no-op rather than a swap, and `ctx.meta` is a Map, so
// `{{__proto__}}` misses instead of resolving to the prototype.)
test("R4-5: `__proto__`/`constructor` as meta, attr and reference keys pollute nothing", () => {
  const before = Object.keys(Object.prototype).length;
  const doc = parse([
    "=== meta",
    "__proto__ = polluted",
    "constructor = polluted",
    "toString = polluted",
    "title = ok",
    "===",
    "",
    "# H {#h}",
    "",
    "=== note {#n .x __proto__ constructor=polluted toString=polluted}",
    "body {{title}}",
    "===",
  ].join("\n"));

  // Nothing was grafted onto the prototype — checked on a FRESH object, on the
  // prototype itself, and by key count (a defined-but-hidden property).
  assert.equal({}.polluted, undefined, "a fresh object gained nothing");
  assert.equal(Object.prototype.polluted, undefined, "Object.prototype gained nothing");
  assert.equal(({}).title, undefined, "…nor the legitimate key");
  assert.equal(Object.keys(Object.prototype).length, before, "no enumerable prototype key was added");
  assert.equal(typeof {}, "object", "and Object still behaves");

  const meta = doc.children.find((b) => b.kind === "block" && b.type === "meta");
  // Every value that DID land is an own, scalar property.
  for (const [k, v] of Object.entries(meta.data)) {
    assert.ok(Object.prototype.hasOwnProperty.call(meta.data, k), `${k} is an OWN property`);
    assert.ok(["string", "number", "boolean"].includes(typeof v), `${k} is a scalar, got ${typeof v}`);
  }
  assert.equal(meta.data.title, "ok", "the legitimate key is unaffected");
  // The attribute object is scalars-only too.
  const note = doc.children.find((b) => b.kind === "block" && b.type === "note");
  for (const [k, v] of Object.entries(note.attrs)) {
    assert.ok(Object.prototype.hasOwnProperty.call(note.attrs, k), `attr ${k} is an OWN property`);
    assert.ok(["string", "number", "boolean"].includes(typeof v), `attr ${k} is a scalar, got ${typeof v}`);
  }
  // `attrs` and `data` ARE plain objects, so `attrs["valueOf"]` still answers
  // with Object.prototype.valueOf — a function. What makes every read of them
  // safe is that the key is always a literal, and no literal the parser or the
  // renderer looks up is an Object.prototype member. That is the invariant to
  // pin: adding an attribute named like a prototype member (or a lookup keyed by
  // document text, which is what REGISTRY was — see R4-4) reopens the hole.
  const READ_KEYS = [
    "src", "data", "format", "format-data", "delim", "header", "schema", "lang", "anchor",
    "caption", "hidden", "as", "rel", "target", "type", "x", "y", "size", "series", "rows",
    "name", "entry-via", "module", "container", "entry", "compute", "summary", "span",
  ];
  for (const key of READ_KEYS) {
    assert.equal(key in {}, false,
      `the attribute name \`${key}\` must not be an Object.prototype member — a plain-object lookup would answer for the prototype`);
  }
  renderHtml(doc, { source: "x.geml" }); // must not throw
});

test("R4-5: `{{__proto__}}` is an unknown reference, not a prototype lookup", () => {
  // META_REF_SRC admits a leading `_`, so `{{__proto__}}` and `{{constructor}}`
  // are well-formed references. Resolving them against a plain object would have
  // interpolated `[object Object]` / a function's source text into the document.
  const doc = parse("=== meta\ntitle = ok\n===\n\n{{__proto__}} {{constructor}} {{toString}} {{title}}\n");
  const para = doc.children.find((b) => b.kind === "paragraph");
  assert.ok(!/object Object|native code|function/.test(para.text),
    `no prototype value was interpolated, got: ${JSON.stringify(para.text)}`);
  assert.ok(para.text.includes("ok"), "the real key still interpolates");
  const codes = doc.diagnostics.filter((d) => d.code === "unknown-metadata-reference");
  assert.equal(codes.length, 3, "each prototype name is reported as unknown");
});

// ---------------------------------------------------------------------------
// R4-6 — the `data:` gate: image payloads reach a MEDIA src and nowhere else
// ---------------------------------------------------------------------------
// isSafeUrl(url, true) admits `data:image/*` for media, which includes
// `data:image/svg+xml` — and SVG can carry script. That is safe ONLY because the
// renderer puts a media src in an `<img>`/`<video>`/`<audio>` element, where a
// browser loads SVG in restricted mode (no script, no external fetch), and
// because `data:` never reaches an href or any element that would execute it.
// Both halves of that argument are properties of the code, so both are pinned
// here: a route that ever emitted a document src into an `<object>`, `<iframe>`,
// `<embed>` or an href would turn this gate into a live XSS.
const R4_6_SVG = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'></svg>";
const R4_6_HTML = renderHtml(parse([
  `![img](${R4_6_SVG})`, "",
  `[link](${R4_6_SVG})`, "",
  "![png](data:image/png;base64,iVBORw0KGgo)", "",
  "![htm](data:text/html,<script>alert(1)</script>)", "",
  "[htm2](data:text/html,<script>alert(1)</script>)", "",
  `![vid](${R4_6_SVG}){as="video"}`, "",
  `![aud](${R4_6_SVG}){as="audio"}`,
].join("\n")), { source: "x.geml" });

test("R4-6: a data:image payload reaches only a media src — never an href, never a scriptable element", () => {
  // No element that would EXECUTE a document-supplied document.
  assert.doesNotMatch(R4_6_HTML, /<(object|iframe|embed|foreignObject)\b/i, "no scriptable container is ever emitted");
  // No data: URI at an href, whatever its media type.
  for (const m of R4_6_HTML.matchAll(/href="([^"]*)"/g)) {
    assert.ok(!/^[\x00-\x20]*data:/i.test(m[1]), `no data: URI at an href, got ${JSON.stringify(m[1])}`);
  }
  // The svg link renders inert (href defaulted to `#`), its text kept.
  assert.match(R4_6_HTML, /<a href="#">link<\/a>/, "a data: link is inert");
  assert.match(R4_6_HTML, /<a href="#">htm2<\/a>/, "so is a data:text/html link");
  // data:text/html is refused even for media: the src is emptied.
  assert.match(R4_6_HTML, /<img class="media" src="" alt="htm">/, "data:text/html media src is blanked");
  assert.ok(!R4_6_HTML.includes("data:text/html"), "the text/html payload appears nowhere in the page");
  // The svg payload that IS admitted is escaped, and sits in a media element only.
  assert.ok(!R4_6_HTML.includes("<svg"), "the SVG markup is escaped, never emitted as markup");
  assert.doesNotMatch(R4_6_HTML.replace(/"[^"]*"/g, '""'), /\son[a-z]+\s*=/i, "no event-handler attribute anywhere");
  for (const m of R4_6_HTML.matchAll(/src="([^"]*)"/g)) {
    if (!/^data:/i.test(m[1])) continue;
    assert.match(m[1], /^data:image\//i, `an admitted data: src is image/* only, got ${JSON.stringify(m[1])}`);
  }
  // …and the legitimate image data URI still works.
  assert.match(R4_6_HTML, /src="data:image\/png;base64,iVBORw0KGgo"/, "data:image/png media kept");
});

// ---------------------------------------------------------------------------
// R4-7 — emphasis wrapping must not smuggle content past the HTML escaping
// ---------------------------------------------------------------------------
// 1.8.0 gives em/strong/del children that used to be text only: a link, an image,
// a code span, a projection. The renderer reaches them through a NEW tree shape,
// so every author-controlled slot is re-checked at every sink, wrapped and
// unwrapped, in a paragraph and inside a typed block.
test("R4-7: every author slot stays escaped when emphasis wraps the construct", () => {
  const payloads = [
    '" onmouseover="alert(1)',
    '"><img src=x onerror=alert(1)>',
    "<script>alert(1)</script>",
    "</script><script>alert(1)</script>",
    "javascript:alert(1)",
    "</style><svg onload=alert(1)>",
  ];
  const slot = (P) => [
    `[${P}](https://ok)`, `[t](${P})`, `[t](https://ok){rel="${P}"}`, `[t](https://ok){target="${P}"}`,
    `![${P}](pic.png)`, `![a](${P})`, "`" + P + "`", `[[#${P}]]`, `[^${P}]`, `![[#${P}]]`, P,
  ];
  const wrap = [(x) => `*${x}*`, (x) => `**${x}**`, (x) => `~~${x}~~`, (x) => `~~*${x}*~~`];
  let checked = 0;
  for (const P of payloads) {
    for (const frag of slot(P)) {
      for (const w of wrap) {
        const html = renderHtml(parse(`# H {#h}\n\npara ${w(frag)} end\n\n=== note {#n}\n${w(frag)}\n===\n`), { source: "x.geml" });
        checked++;
        // (a) nothing the document wrote may land inside a <script>/<style> body
        for (const m of html.matchAll(/<(script|style)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)) {
          assert.ok(!m[2].includes("alert(1)"), `document payload inside <${m[1]}>: ${P}`);
        }
        // The page's own <style>/<script> are renderer literals; blank them, then
        // read the remaining tags. Inside a quoted value `on…=` is inert text, so
        // only markup OUTSIDE the quotes can be an event handler.
        const outside = html.replace(/<style>[\s\S]*?<\/style>/g, "").replace(/<script(?:\s[^>]*)?>[\s\S]*?<\/script>/g, "");
        for (const tag of outside.matchAll(/<[a-z][a-z0-9]*\b[^>]*>/gi)) {
          const bare = tag[0].replace(/"[^"]*"/g, '""');
          assert.doesNotMatch(bare, /\son[a-z]+\s*=/i, `event handler emitted for ${JSON.stringify(P)}: ${tag[0].slice(0, 90)}`);
          assert.equal((tag[0].match(/"/g) || []).length % 2, 0, `attribute breakout for ${JSON.stringify(P)}: ${tag[0].slice(0, 90)}`);
          for (const v of tag[0].matchAll(/"([^"]*)"/g)) {
            assert.ok(!v[1].includes("<") && !v[1].includes(">"), `raw angle bracket in an attribute value: ${v[1].slice(0, 60)}`);
          }
        }
        // (b) no dangerous scheme at any sink, normalized the way a browser does
        for (const m of outside.matchAll(/(?:href|src)="([^"]*)"/g)) {
          const v = m[1].replace(/[\x00-\x20]/g, "").toLowerCase();
          assert.ok(!v.startsWith("javascript:") && !v.startsWith("vbscript:") && !v.startsWith("data:text/html"),
            `dangerous sink for ${JSON.stringify(P)}: ${JSON.stringify(m[1])}`);
        }
      }
    }
  }
  assert.ok(checked >= 250, `the matrix really ran (${checked} renders)`);
});

// ---------------------------------------------------------------------------
// R4-8 — scheme-allowlist evasions BEYOND the C0 controls R2-2 pins
// ---------------------------------------------------------------------------
// schemeOf strips [\x00-\x20] before matching, which covers the C0 family. These
// are the neighbours of that class: DEL (0x7f, NOT stripped by a browser's URL
// parser either), a Cyrillic/Greek homoglyph, a full-width colon, and mixed case
// around an embedded newline. Each must end up inert — either refused as a
// scheme, or reduced to a relative path whose control bytes esc() replaces.
test("R4-8: DEL, homoglyph and full-width-colon scheme evasions never reach a live sink", () => {
  const DEL = String.fromCharCode(0x7f);
  const bad = [
    `java${DEL}script:alert(1)`,      // DEL inside the scheme
    `${DEL}javascript:alert(1)`,      // DEL before it
    "ϳavascript:alert(1)",       // GREEK LETTER YOT homoglyph for `j`
    "јavascript:alert(1)",       // CYRILLIC SMALL LETTER JE
    "javascript：alert(1)",       // FULLWIDTH COLON
    "JaVa\nScRiPt:alert(1)",          // mixed case around a newline
    "\tj\ta\tv\ta\ts\tc\tr\ti\tp\tt:alert(1)", // one control per character
  ];
  const html = renderHtml(parse(bad.flatMap((d, i) => [`[l${i}](${d})`, "", `![m${i}](${d})`, ""]).join("\n")), { source: "x.geml" });
  for (const m of html.matchAll(/(?:href|src)="([^"]*)"/g)) {
    // Normalize the way a browser does before acting on a URL: drop C0+space.
    const v = m[1].replace(/[\x00-\x20]/g, "").toLowerCase();
    assert.ok(!v.startsWith("javascript:"), `no javascript: at a sink, got ${JSON.stringify(m[1])}`);
    assert.ok(!v.startsWith("vbscript:"), `no vbscript: at a sink, got ${JSON.stringify(m[1])}`);
    // A DEL byte in an emitted URL is replaced by U+FFFD, so a scheme cannot be
    // reassembled from it downstream either.
    assert.ok(!m[1].includes(DEL), `no raw DEL byte at a sink, got ${JSON.stringify(m[1])}`);
  }
  assert.ok(!html.includes("alert(1)</a>"), "no payload became link text through a stripped scheme");
  // The all-tabs form IS a javascript: URL to a browser, so it must be refused
  // outright rather than emitted as a relative path.
  assert.match(html, /<a href="#">l6<\/a>/, "the control-separated scheme is refused (inert link)");
  assert.match(html, /<img class="media" src="" alt="m6">/, "…and its media src is blanked");
});

console.log(`\n${passed} test(s) passed.`);

// --- a link may point at a directory; a content route may not
//
// `[the extension](integrations/vscode/)` is an ordinary link that a forge
// renders as a listing. Calling it broken made every real project's README
// fail `geml check` — but the relaxation is only for LINKS, and only inside
// the confinement root, or link checking becomes a probe for what exists.

test("a link to a directory that exists is not a broken link", () => {
  const root = mkdtempSync(join(tmpdir(), "geml-dirlink-"));
  try {
    mkdirSync(join(root, "realdir", "nested"), { recursive: true });
    writeFileSync(join(root, "realdir", "f.txt"), "x\n");
    const main = join(root, "main.geml");
    writeFileSync(main,
      "# Main {#top}\n\n" +
      "with slash [a](realdir/)\n\n" +
      "no slash   [b](realdir)\n\n" +
      "nested     [c](realdir/nested/)\n");
    const r = spawnSync(process.execPath, ["dist/geml.js", "check", main], { encoding: "utf8", timeout: 60000 });
    assert.equal(r.status, 0, (r.stdout || "") + (r.stderr || ""));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a directory carries no anchors, and a missing one is still missing", () => {
  const root = mkdtempSync(join(tmpdir(), "geml-diranchor-"));
  try {
    mkdirSync(join(root, "realdir"), { recursive: true });
    const main = join(root, "main.geml");
    writeFileSync(main,
      "# Main {#top}\n\n" +
      "anchor  [a](realdir/#nope)\n\n" +
      "absent  [b](nosuchdir/)\n");
    const r = spawnSync(process.execPath, ["dist/geml.js", "check", main], { encoding: "utf8", timeout: 60000 });
    const out = (r.stdout || "") + (r.stderr || "");
    // The fragment is NOT judged here any more. A directory is not a `.geml`
    // document, and the rule that a fragment belongs to the format that owns it
    // absorbed this case: a forge's directory listing is a page with element
    // ids of its own, so calling `realdir/#nope` broken was the same overreach
    // as calling `page.html#sec` broken. What remains is the part GEML can
    // actually know — whether the target is there at all.
    assert.doesNotMatch(out, /realdir/, "a fragment on a non-GEML target is left alone");
    assert.match(out, /cannot resolve document `nosuchdir\/`/, "absence is still an error");
    assert.match(out, /1 error\(s\)/);
    assert.equal(r.status, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the directory relaxation does not leak existence past the confinement root", () => {
  // Answering "yes, that exists" for a path outside the root would turn link
  // checking into a probe of the machine — the gates apply to both halves.
  const root = mkdtempSync(join(tmpdir(), "geml-dirconfine-"));
  try {
    const base = join(root, "base");
    mkdirSync(base, { recursive: true });
    mkdirSync(join(root, "outside"), { recursive: true });   // exists, one level up
    const main = join(base, "main.geml");
    writeFileSync(main, "# Main {#top}\n\nup [a](../outside/)\n");
    const r = spawnSync(process.execPath, ["dist/geml.js", "check", main], { encoding: "utf8", timeout: 60000 });
    const out = (r.stdout || "") + (r.stderr || "");
    assert.match(out, /cannot resolve document `\.\.\/outside\/`/, "an existing directory outside the root is still refused");
    assert.equal(r.status, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("content routes still refuse a directory — they need bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "geml-dirsrc-"));
  try {
    mkdirSync(join(root, "realdir"), { recursive: true });
    const cases = [
      ["embed", "=== embed {#e src=realdir/}\n===\n", /not a GEML document/],
      ["table", "=== table {#tb src=realdir/}\n===\n", /not a `\.csv`\/`\.tsv`/],
      ["data", "=== data {#d format=json src=realdir/}\n===\n", /not a `\.json`\/`\.jsonl`/],
    ];
    for (const [name, block, expected] of cases) {
      const f = join(root, `${name}.geml`);
      writeFileSync(f, `# Main {#top}\n\n${block}`);
      const r = spawnSync(process.execPath, ["dist/geml.js", "check", f], { encoding: "utf8", timeout: 60000 });
      const out = (r.stdout || "") + (r.stderr || "");
      assert.match(out, expected, `${name} src= must not accept a directory`);
      assert.equal(r.status, 1, `${name} src= directory should fail`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- a fragment belongs to the format that owns it
//
// `#frag` means a GEML block id only in a `.geml` target. In `page.html#sec` it
// is an element id; in `notes.md#sec` a forge's slug or an `<a id>`. Judging
// those by GEML's rules was wrong in BOTH directions — and worse, it passed by
// accident whenever the name appeared anywhere in the target, which is why this
// repo's own `GEML-spec.md#appendix-a-diagnostic-catalogue` was green off a
// string that lives inside a link there.

test("a fragment on a non-GEML target is left to that format", () => {
  const root = mkdtempSync(join(tmpdir(), "geml-frag-"));
  try {
    writeFileSync(join(root, "b.html"), '<html><body><div id="sec">x</div></body></html>\n');
    writeFileSync(join(root, "c.md"), '# Title\n\n<a id="sec"></a>\n## Section\n');
    const main = join(root, "main.geml");
    writeFileSync(main,
      "# M {#t}\n\n" +
      "html [a](b.html#sec)\n\n" +
      "md   [b](c.md#sec)\n\n" +
      "slug [c](c.md#section)\n\n" +
      "none [d](c.md#not-there-either)\n");
    const r = spawnSync(process.execPath, ["dist/geml.js", "check", main], { encoding: "utf8", timeout: 60000 });
    assert.equal(r.status, 0, (r.stdout || "") + (r.stderr || ""));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the document behind a foreign fragment must still exist", () => {
  const root = mkdtempSync(join(tmpdir(), "geml-frag-missing-"));
  try {
    const main = join(root, "main.geml");
    writeFileSync(main, "# M {#t}\n\n[a](gone.html#sec)\n");
    const r = spawnSync(process.execPath, ["dist/geml.js", "check", main], { encoding: "utf8", timeout: 60000 });
    assert.match((r.stdout || "") + (r.stderr || ""), /cannot resolve document `gone\.html`/);
    assert.equal(r.status, 1, "a link to a file that is not there is broken whatever its format");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a fragment on a .geml target is still checked, exactly as before", () => {
  const root = mkdtempSync(join(tmpdir(), "geml-frag-geml-"));
  try {
    writeFileSync(join(root, "d.geml"), "=== note {#sec}\nreal block\n===\n");
    const main = join(root, "main.geml");
    writeFileSync(main, "# M {#t}\n\ngood [a](d.geml#sec)\n\nbad [b](d.geml#nope)\n");
    const r = spawnSync(process.execPath, ["dist/geml.js", "check", main], { encoding: "utf8", timeout: 60000 });
    const out = (r.stdout || "") + (r.stderr || "");
    assert.match(out, /unresolved reference `d\.geml#nope`/);
    assert.doesNotMatch(out, /d\.geml#sec/, "the one that resolves stays silent");
    assert.equal(r.status, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
