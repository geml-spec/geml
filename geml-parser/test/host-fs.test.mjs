// The filesystem host (src/host-fs.ts): the confinement gates every disk-bound
// surface shares. Each test builds its own tree under the OS temp directory,
// uses `path.join` throughout, and never creates a symlink — the symlink gates
// are exercised by the security suites where a platform can make one.
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { docOptsFor, existsFor, fsFiles, gemlFilesUnder, historyError, readConfined, resolverFor, shownPath } from "../dist/host-fs.js";
import { ViewError } from "../dist/verbs.js";

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "geml-hostfs-"));
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, ...rel.split("/"));
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, text);
  }
  return root;
}

test("resolverFor reads under the document's directory, widens to --root, and refuses escapes", () => {
  const root = tree({ "a.geml": "A", "sub/b.geml": "B", "sub/deep/c.geml": "C", "outside.txt": "O" });
  try {
    const fromSub = resolverFor(join(root, "sub", "b.geml"));
    assert.equal(fromSub("deep/c.geml"), "C");
    assert.equal(fromSub("../a.geml"), null, "a `..` past the document's directory is refused without a root");
    assert.equal(fromSub("nope.geml"), null);
    const widened = resolverFor(join(root, "sub", "b.geml"), root);
    assert.equal(widened("../a.geml"), "A", "--root admits the sibling directory");
    assert.equal(widened("a.geml"), "A", "a source route written relative to the root is found from the root");
    assert.equal(widened("../../outside.txt"), null, "…but nothing past the root");
    assert.equal(resolverFor(join(root, "sub", "b.geml"), join(root, "does-not-exist"))("b.geml"), null,
      "a root that cannot be canonicalized resolves nothing");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("existsFor answers for directories and missing targets behind the same gates", () => {
  const root = tree({ "a.geml": "A", "sub/b.geml": "B" });
  try {
    const exists = existsFor(join(root, "a.geml"));
    assert.equal(exists("sub"), true, "a directory exists even though it has no text");
    assert.equal(exists("sub/b.geml"), true);
    assert.equal(exists("missing.geml"), false);
    assert.equal(exists("../"), false, "a `..` escape does not exist, as far as this document is concerned");
    assert.equal(existsFor(join(root, "a.geml"), join(root, "nope"))("sub"), false);
    const both = docOptsFor(join(root, "sub", "b.geml"), root);
    assert.equal(both.resolveDoc("../a.geml"), "A");
    assert.equal(both.docExists("../a.geml"), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("readConfined reads a .geml under the root and refuses anything else, with the codes the chain reports", () => {
  const root = tree({ "part.geml": "P", "sub/inner.geml": "I", "notes.md": "M" });
  try {
    assert.equal(readConfined("part.geml", root), "P");
    assert.equal(readConfined("sub/inner.geml", root), "I");
    const md = assert.throws(() => readConfined("notes.md", root), ViewError);
    void md;
    try { readConfined("notes.md", root); } catch (e) { assert.equal(e.code, "embed-target-not-geml"); assert.equal(e.exit, 1); }
    try { readConfined("../escape.geml", root); } catch (e) { assert.equal(e.code, "unresolvable-document"); assert.match(e.message, /outside the confinement root/); }
    try { readConfined("missing.geml", root); } catch (e) { assert.equal(e.code, "unresolvable-document"); assert.match(e.message, /cannot resolve/); }
    assert.equal(fsFiles.readConfined, readConfined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("shownPath states provenance relative to the root, in forward slashes, and leaves the root itself alone", () => {
  const root = join(tmpdir(), "geml-shown");
  assert.equal(shownPath(join(root, "sub", "part.geml"), root), "sub/part.geml");
  assert.equal(shownPath(root, root), root, "a path that IS the root has no relative spelling");
  assert.equal(fsFiles.shownPath, shownPath);
});

test("gemlFilesUnder walks both formats the parser reads, in sorted order, skips hidden and vendored directories, and takes a named file whatever its extension", () => {
  const root = tree({
    "b.geml": "", "a.geml": "", "readme.md": "", "UPPER.MD": "",
    "app.ts": "", "page.geml.gemlhistory": "",
    "sub/z.geml": "", "sub/y.md": "",
    ".hidden/h.geml": "", "node_modules/n.geml": "",
  });
  try {
    const out = [];
    gemlFilesUnder(root, out);
    // Markdown is walked because every other verb already reads it: a walk that
    // found only `.geml` answered "no matches" about a directory of notes.
    // `.ts` is not walked, or a bare `geml find` would drag a source tree
    // through the parser. `.gemlhistory` is a sidecar, not a document.
    assert.deepEqual(out.map((p) => p.slice(root.length + 1).replace(/\\/g, "/")),
      ["UPPER.MD", "a.geml", "b.geml", "readme.md", "sub/y.md", "sub/z.geml"]);
    const named = [];
    gemlFilesUnder(join(root, "app.ts"), named, true);
    assert.deepEqual(named.map((p) => basename(p)), ["app.ts"], "a file the caller named is searched whatever it is called");
    const unnamed = [];
    gemlFilesUnder(join(root, "app.ts"), unnamed);
    assert.deepEqual(unnamed, [], "a file the walk found in a format the parser does not read is skipped");
    gemlFilesUnder(join(root, "does-not-exist"), unnamed);
    assert.deepEqual(unnamed, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("historyError words a missing sidecar, a missing document, and any other failure without a stack", () => {
  const enoent = (path) => Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT", path });
  assert.equal(historyError(enoent("/x/d.gemlhistory"), "d.geml", "/x/d.gemlhistory"), "cannot read history /x/d.gemlhistory");
  assert.equal(historyError(enoent("/x/d.geml"), "d.geml", "/x/d.gemlhistory"), "cannot read d.geml");
  assert.equal(historyError(Object.assign(new Error("gone"), { code: "ENOENT" }), "d.geml", "h"), "cannot read d.geml", "an ENOENT with no path is the document");
  assert.equal(historyError(new Error("chain broken"), "d.geml", "h"), "chain broken");
  assert.equal(historyError("plain string", "d.geml", "h"), "plain string");
});
