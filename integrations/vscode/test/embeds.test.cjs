// The scan that tells the preview which sibling documents to read for it.
//
// Run against out/, so this tests what actually ships rather than a re-compile
// of the sources with different settings.

const { strict: assert } = require("node:assert");
const { embedDocPaths, isLocalDocPath, confineToFolder } = require("../out/embeds.js");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

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


// R5 (SEC-001): the folder-prefix check is lexical. A symlink committed to a
// repository is SPELLED inside the folder and resolves wherever it points, and
// readFile follows it — so `notes.geml -> /etc/passwd` beside the document walked
// through both lexical locks and landed in the preview. The realpaths decide.
test("a symlink spelled inside the folder but pointing out of it is refused; a real neighbour and a missing one are not confused with it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "geml-embeds-confine-"));
  const dir = path.join(root, "docdir");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(root, "secret.txt"), "TOP SECRET");
  fs.writeFileSync(path.join(dir, "a.geml"), "x");
  assert.equal(confineToFolder(dir, path.join(dir, "a.geml")).verdict, "inside", "a real neighbour is inside");
  assert.equal(confineToFolder(dir, path.join(dir, "nope.geml")).verdict, "missing", "a missing neighbour is missing, not outside");
  let linked = true;
  try { fs.symlinkSync(path.join(root, "secret.txt"), path.join(dir, "notes.geml")); } catch { linked = false; }
  if (linked) {
    assert.equal(confineToFolder(dir, path.join(dir, "notes.geml")).verdict, "outside", "a link that leaves the folder is outside, whatever it is spelled");
    // …and a link that stays inside is fine: the refusal is about where it lands.
    fs.symlinkSync(path.join(dir, "a.geml"), path.join(dir, "alias.geml"));
    assert.equal(confineToFolder(dir, path.join(dir, "alias.geml")).verdict, "inside");
  }
  // The realpath is injectable, so the verdict can be pinned without a filesystem too.
  const fake = (p) => (p.endsWith("evil.geml") ? "/elsewhere/secret" : p);
  assert.equal(confineToFolder("/docs", "/docs/evil.geml", fake).verdict, "outside");
  assert.equal(confineToFolder("/docs", "/docs/ok.geml", fake).verdict, "inside");
});

console.log(`\n${passed} test(s) passed.`);
