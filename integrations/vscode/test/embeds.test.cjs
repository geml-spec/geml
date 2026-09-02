// The scan that tells the preview which sibling documents to read for it.
//
// Run against out/, so this tests what actually ships rather than a re-compile
// of the sources with different settings.

const { strict: assert } = require("node:assert");
const { embedDocPaths, isLocalDocPath } = require("../out/embeds.js");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const MIXED = [
  "=== meta",
  'title = "Publishing"',
  'profile = "geml-translator/v1"',
  "===",
  "",
  "=== embed {src=publishing.geml#pub part=head}",
  "===",
  "",
  "=== embed {src=publishing.geml#cmd translate-to=none}",
  "===",
].join("\n");

test("an embed's src is found, with the fragment stripped", () => {
  assert.deepEqual(embedDocPaths("=== embed {src=publishing.geml#cmd}\n==="), ["publishing.geml"]);
});

test("the same document named eight times is read once", () => {
  assert.deepEqual(embedDocPaths(MIXED), ["publishing.geml"]);
});

test("a quoted src, and a table's data file, count too", () => {
  const doc = [
    '=== table {#fy src="rows.csv" format=csv header=1}',
    "===",
    "",
    '=== embed {src="notes.geml#top"}',
    "===",
  ].join("\n");
  assert.deepEqual(embedDocPaths(doc), ["rows.csv", "notes.geml"]);
});

test("CRLF text scans the same as LF", () => {
  assert.deepEqual(embedDocPaths(MIXED.split("\n").join("\r\n")), ["publishing.geml"]);
});

test("a same-document embed asks for no file", () => {
  assert.deepEqual(embedDocPaths("=== embed {src=#pub}\n==="), []);
});

test("prose that merely mentions src= is not a fence", () => {
  assert.deepEqual(embedDocPaths("See `=== embed {src=other.geml}` for the shape.\n"), []);
  assert.deepEqual(embedDocPaths("src=other.geml\n"), []);
});

test("the cap bounds how many files one keystroke can ask for", () => {
  const many = Array.from({ length: 40 }, (_, i) => `=== embed {src=d${i}.geml#a}\n===`).join("\n\n");
  assert.equal(embedDocPaths(many).length, 16);
  assert.equal(embedDocPaths(many, 3).length, 3);
});

test("only relative paths inside the document's folder are read for it", () => {
  for (const p of [
    "https://example.com/a.geml",
    "http://example.com/a.geml",
    "file:///c:/tmp/a.geml",
    "mailto:someone@example.com",
    "/etc/passwd",
    "C:\\Windows\\win.ini",
    "sub\\a.geml",
    "../secrets.geml",
    "a/../../secrets.geml",
    "notes",           // no extension: prose, not a path
    "",
  ]) {
    assert.equal(isLocalDocPath(p), false, p);
    assert.deepEqual(embedDocPaths(`=== embed {src=${p}}\n===`), [], p);
  }
  for (const p of ["publishing.geml", "sub/notes.geml", "data/rows.csv", "a.gemlhistory"]) {
    assert.equal(isLocalDocPath(p), true, p);
  }
});

console.log(`\n${passed} test(s) passed.`);
