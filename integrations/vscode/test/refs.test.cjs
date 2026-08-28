// The reference lexer, the block-at-a-line rule, and the id whitelist.
//
// Run against out/, so this tests what actually ships rather than a re-compile
// of the sources with different settings.

const { strict: assert } = require("node:assert");
const { vscode, makeDoc, install } = require("./vscode-stub.cjs");

install();
const { refsOnLine, refAt, idRangeOnLine } = require("../out/refs.js");
const { isSafeId, shellSafe, matchEol, unitAt, unitById } = require("../out/cli.js");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

/** The refs on a one-line document, flattened to something readable. */
const scan = (line) =>
  refsOnLine(makeDoc(line), 0).map((t) => ({
    id: t.id,
    path: t.path,
    // The text the range actually covers, so an off-by-one cannot pass.
    tok: line.slice(t.range.start.character, t.range.end.character),
    idText: t.idRange ? line.slice(t.idRange.start.character, t.idRange.end.character) : undefined,
  }));

// ---------------------------------------------------------------------------
// The five §5.2 forms plus the block-head attribute
// ---------------------------------------------------------------------------

test("auto-ref, same document", () => {
  assert.deepEqual(scan("See [[#budget]] for the numbers."),
    [{ id: "budget", path: undefined, tok: "[[#budget]]", idText: "budget" }]);
});

test("auto-ref, cross-document", () => {
  assert.deepEqual(scan("As in [[other.geml#top]]."),
    [{ id: "top", path: "other.geml", tok: "[[other.geml#top]]", idText: "top" }]);
});

test("inline projection carries the leading bang in its token", () => {
  assert.deepEqual(scan("Tagline: ![[#tagline]]"),
    [{ id: "tagline", path: undefined, tok: "![[#tagline]]", idText: "tagline" }]);
});

test("explicit-text ref, same document — the token covers the label too", () => {
  // The label is where a reader's mouse lands, so it has to be part of the
  // token; a hover that answers only over `](#budget)` is one nobody finds.
  assert.deepEqual(scan("[the table](#budget) shows it."),
    [{ id: "budget", path: undefined, tok: "[the table](#budget)", idText: "budget" }]);
});

test("explicit-text ref, cross-document", () => {
  assert.deepEqual(scan("[there](notes.geml#intro)"),
    [{ id: "intro", path: "notes.geml", tok: "[there](notes.geml#intro)", idText: "intro" }]);
});

test("hovering the label of an explicit-text ref works", () => {
  const line = "[the table](#budget) shows it.";
  const doc = makeDoc(line);
  assert.equal(refAt(doc, new vscode.Position(0, 3))?.id, "budget", "inside the label");
  assert.equal(refAt(doc, new vscode.Position(0, 14))?.id, "budget", "inside the target");
  assert.equal(refAt(doc, new vscode.Position(0, 25))?.id, undefined, "past the token");
});

test("a label containing brackets still resolves to its own opening bracket", () => {
  assert.deepEqual(scan("[see [1] there](#budget)"),
    [{ id: "budget", path: undefined, tok: "[see [1] there](#budget)", idText: "budget" }]);
});

test("an image is not a document reference", () => {
  // `![alt](x.png)` shares its shape with a cross-document link, and treating it
  // as one offered to navigate to a picture.
  assert.deepEqual(scan("![alt text](diagram.png)"), []);
  assert.deepEqual(scan("Chart: ![img](a.png) done"), []);
  // …but the projection form, which is a reference, keeps working.
  assert.deepEqual(scan("![[#tagline]]").map((r) => r.id), ["tagline"]);
});

test("src= on a block head is navigable too", () => {
  assert.deepEqual(scan("=== embed {src=#budget}"),
    [{ id: "budget", path: undefined, tok: "src=#budget", idText: "budget" }]);
  assert.deepEqual(scan('=== embed {src="#budget"}'),
    [{ id: "budget", path: undefined, tok: 'src="#budget"', idText: "budget" }]);
});

test("a document reference with no fragment is a document, not a block", () => {
  assert.deepEqual(scan("see [the notes](notes.md)"),
    [{ id: undefined, path: "notes.md", tok: "[the notes](notes.md)", idText: undefined }]);
  assert.deepEqual(scan("see [[appendix.geml]]"),
    [{ id: undefined, path: "appendix.geml", tok: "[[appendix.geml]]", idText: undefined }]);
});

// ---------------------------------------------------------------------------
// What must NOT be read as a block reference
// ---------------------------------------------------------------------------

test("a URL is a link, not a block reference — its # is a page fragment", () => {
  assert.deepEqual(scan("[docs](https://example.com/page#section)"), []);
  assert.deepEqual(scan("[mail](mailto:a@b.c)"), []);
  assert.deepEqual(scan("[api](http://localhost:8080/#x)"), []);
});

test("ordinary brackets and parens are not references", () => {
  assert.deepEqual(scan("An aside [like this] and (this) too."), []);
  assert.deepEqual(scan("[a](b)"), [], "no dot and no fragment — prose, not a target");
});

test("several references on one line are all found", () => {
  const got = scan("Both [[#a]] and [x](other.geml#b) apply.");
  assert.deepEqual(got.map((r) => r.id), ["a", "b"]);
  assert.deepEqual(got.map((r) => r.path), [undefined, "other.geml"]);
});

test("a non-ASCII id survives the lexer intact", () => {
  // §4 keeps every Unicode letter in a derived id, so navigation has to as well.
  assert.deepEqual(scan("见 [[#设计说明]]。"),
    [{ id: "设计说明", path: undefined, tok: "[[#设计说明]]", idText: "设计说明" }]);
});

// ---------------------------------------------------------------------------
// refAt — the cursor has to be ON the token
// ---------------------------------------------------------------------------

test("refAt answers only inside the token", () => {
  const line = "See [[#budget]] now.";
  const doc = makeDoc(line);
  const at = (col) => refAt(doc, new vscode.Position(0, col))?.id;
  assert.equal(at(0), undefined, "before it");
  assert.equal(at(4), "budget", "on the opening bracket");
  assert.equal(at(9), "budget", "inside the id");
  assert.equal(at(14), "budget", "on the closing bracket");
  assert.equal(at(18), undefined, "after it");
});

// ---------------------------------------------------------------------------
// idRangeOnLine — where a declared id sits, id-boundary safe
// ---------------------------------------------------------------------------

test("idRangeOnLine finds a declared id and respects id boundaries", () => {
  const line = "=== table {#budget-2 caption=\"Q3\"}";
  const doc = makeDoc(line);
  const r = idRangeOnLine(doc, 0, "budget-2");
  assert.ok(r, "the full id is found");
  assert.equal(line.slice(r.start.character, r.end.character), "budget-2");

  // The trap `geml rename` calls id-boundary safety: `#budget` must not be
  // located inside `#budget-2`.
  assert.equal(idRangeOnLine(doc, 0, "budget"), undefined);
});

test("idRangeOnLine returns nothing for a heading whose id is derived", () => {
  // `## Quarterly report` derives `#quarterly-report` — there is no `#id` text
  // on the line, and rename must decline rather than guess.
  assert.equal(idRangeOnLine(makeDoc("## Quarterly report"), 0, "quarterly-report"), undefined);
  assert.ok(idRangeOnLine(makeDoc("## Quarterly report {#qr}"), 0, "qr"));
});

// ---------------------------------------------------------------------------
// isSafeId — the whitelist that keeps document text out of a shell
// ---------------------------------------------------------------------------

test("isSafeId accepts every id §4's derivation can produce", () => {
  for (const id of ["budget", "budget-2", "foo_bar", "use-in-2024-design", "设计说明", "ubytovací-zařízení", "a.b", "ns:id"]) {
    assert.equal(isSafeId(id), true, id);
  }
});

test("isSafeId refuses anything a shell would read as syntax", () => {
  for (const id of ["a&b", "a|b", "a;b", 'a"b', "a'b", "a b", "a>b", "a$b", "a`b", "a\nb", "$(x)", "..\\x", "", "#x"]) {
    assert.equal(isSafeId(id), false, JSON.stringify(id));
  }
  assert.equal(isSafeId("x".repeat(201)), false, "and refuses an absurd length");
});

// ---------------------------------------------------------------------------
// shellSafe — what may go into argv at all
// ---------------------------------------------------------------------------

test("shellSafe refuses every character measured to break a Windows command line", () => {
  // Each of these was observed doing real damage, not guessed at:
  //   a&b.geml -> cmd runs `b.geml`          (injection)
  //   a^b.geml -> arrives as `ab.geml`       (silent corruption)
  //   a|b.geml -> the command line breaks
  //   %PATH%   -> expands, even inside quotes
  for (const arg of ["a&b.geml", "a^b.geml", "a|b.geml", "%PATH%", "a>b", "a<b", 'a"b', "a`b", "a$b", "a\nb", "a\rb", "a\tb"]) {
    assert.equal(shellSafe(arg), false, JSON.stringify(arg));
  }
});

test("shellSafe allows the filenames people actually have", () => {
  // Spaces and parentheses are ordinary in a filename and are handled by
  // quoting, so refusing them would make the feature useless in practice.
  for (const arg of ["notes.geml", "My Notes.geml", "report (final).geml", "设计说明.geml", "a-b_c.2.geml", "#budget", "## A Heading", "=== table"]) {
    assert.equal(shellSafe(arg), true, JSON.stringify(arg));
  }
});

test("isSafeId is strictly tighter than shellSafe", () => {
  // An id comes from the document; a filename comes from the filesystem. The
  // stricter rule applies to the less trusted source.
  for (const id of ["a b", "a(1)", "a/b", "a\\b", "a*b", "a?b", "a!b", "a=b", "a,b"]) {
    assert.equal(isSafeId(id), false, `${JSON.stringify(id)} is not a usable id`);
  }
  assert.equal(shellSafe("a b"), true, "…even where the shell rule permits it");
});

// ---------------------------------------------------------------------------
// matchEol — a whole-document replace must not convert line endings
// ---------------------------------------------------------------------------

test("matchEol restores CRLF only when the CLI dropped it", () => {
  const crlfDoc = makeDoc("a\r\nb", { eol: vscode.EndOfLine.CRLF });
  const lfDoc = makeDoc("a\nb");
  assert.equal(matchEol(crlfDoc, "x\ny"), "x\r\ny", "LF output into a CRLF document is converted");
  assert.equal(matchEol(crlfDoc, "x\r\ny"), "x\r\ny", "output that already has CRLF is left alone");
  assert.equal(matchEol(lfDoc, "x\ny"), "x\ny", "an LF document is never given CRLF");
});

// ---------------------------------------------------------------------------
// unitAt — the smallest block containing a line, as `geml get 'L27'` defines it
// ---------------------------------------------------------------------------

const UNITS = [
  { address: "#top", kind: "heading", lines: [3, 24], id: "top", level: 1 },
  { address: "#alpha", kind: "heading", lines: [7, 20], id: "alpha", level: 2 },
  { address: "#t1", kind: "table", lines: [11, 15], id: "t1" },
  { address: "#deep", kind: "heading", lines: [17, 20], id: "deep", level: 3 },
  { address: "#beta", kind: "heading", lines: [21, 24], id: "beta", level: 2 },
];

test("unitAt picks the innermost block, not the enclosing section", () => {
  // 0-based in, 1-based spans above.
  assert.equal(unitAt(UNITS, 12 - 1).address, "#t1", "inside the table");
  assert.equal(unitAt(UNITS, 9 - 1).address, "#alpha", "in the section but not the table");
  assert.equal(unitAt(UNITS, 18 - 1).address, "#deep");
  assert.equal(unitAt(UNITS, 22 - 1).address, "#beta");
  assert.equal(unitAt(UNITS, 4 - 1).address, "#top", "only the top-level section covers it");
  assert.equal(unitAt(UNITS, 1 - 1), undefined, "above every block");
  assert.equal(unitAt(UNITS, 99), undefined, "past the end");
});

test("unitById finds a block by id and nothing by a wrong one", () => {
  assert.equal(unitById(UNITS, "t1").kind, "table");
  assert.equal(unitById(UNITS, "nope"), undefined);
});

console.log(`\n${passed} test(s) passed.`);
