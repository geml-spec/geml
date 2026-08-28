// The CLI contract the editor depends on.
//
// Every feature here is a wrapper, so what actually has to hold is the shape of
// the CLI's answers: exit 0 with the document on stdout, or exit 1 with one
// `error: …` sentence on stderr. The rename provider shows that sentence to the
// user and replaces the whole buffer with that stdout, so if either half of the
// contract moved, the editor would either lose the explanation or write nonsense.
//
// Runs against the repo's own freshly built parser rather than a globally
// installed `geml`, so it is the same in CI as it is here.

const { strict: assert } = require("node:assert");
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { makeDoc, install, setSetting, vscode } = require("./vscode-stub.cjs");

const CLI = path.resolve(__dirname, "../../../geml-parser/dist/cli.js");
if (!existsSync(CLI)) {
  console.log("skip: geml-parser is not built (run `npm ci && npm run build` in geml-parser) — CLI contract not checked");
  process.exit(0);
}
if (/\s/.test(CLI)) {
  // `geml.check.path` is whitespace-split into argv, so a repo checked out under
  // a path with a space cannot be addressed this way. Say so rather than fail.
  console.log(`skip: repo path contains whitespace (${CLI}) — CLI contract not checked`);
  process.exit(0);
}

install();
// `node`, not process.execPath: on Windows the real path is under
// "C:\Program Files\", and geml.check.path splits on whitespace. Anything
// running this file already has node on PATH.
setSetting("geml.check.path", `node ${CLI}`);
const { runCli, runCliOnFile, spawnCli, listUnits } = require("../out/cli.js");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok", name); }

// The CLI resolves a cross-document reference relative to the CWD, which runCli
// sets to the document's own directory — so these documents live next to
// fixtures/b.geml, which is what `[[b.geml#other]]` below points at. Put them
// anywhere else and every rename here is refused for a reason that has nothing
// to do with renaming.
const HERE = path.join(__dirname, "fixtures", "doc.geml");
const doc = (text, opts = {}) => makeDoc(text, { path: HERE, ...opts });

async function main() {

const DOC = [
  "%% geml 1.0",
  "",
  "# Report {#top}",
  "",
  "See [[#budget]] and [the table](#budget) and [[b.geml#other]].",
  "",
  "=== table {#budget}",
  "| a | b |",
  "| - | - |",
  "| 1 | 2 |",
  "===",
  "",
  "=== embed {src=#budget}",
  "===",
].join("\n");

// ---------------------------------------------------------------------------

await test("rename rewrites every reference form and leaves a cross-document one alone", async () => {
  const r = await runCli(doc(DOC), ["rename", "-", "#budget", "#spend"]);
  assert.ok(r, "the CLI ran");
  assert.equal(r.code, 0, `exit 0; stderr was ${JSON.stringify(r.stderr)}`);

  // All four §5.2 forms plus the block head and `src=`.
  assert.match(r.stdout, /\[\[#spend\]\]/, "auto-ref");
  assert.match(r.stdout, /\[the table\]\(#spend\)/, "explicit-text ref");
  assert.match(r.stdout, /=== table \{#spend\}/, "the declaration");
  assert.match(r.stdout, /src=#spend/, "the embed's src");
  assert.ok(!r.stdout.includes("#budget"), "no occurrence of the old id survives");
  assert.match(r.stdout, /\[\[b\.geml#other\]\]/, "a reference into another document is untouched");
});

await test("a refused rename says why on stderr and writes nothing", async () => {
  for (const [args, expected] of [
    [["rename", "-", "#budget", "#top"], /already exists/],
    [["rename", "-", "#nosuch", "#x"], /no block with id/],
  ]) {
    const r = await runCli(doc(DOC), args);
    assert.ok(r);
    assert.equal(r.code, 1, `${args.join(" ")} exits non-zero`);
    assert.equal(r.stdout, "", "nothing on stdout — there is no document to write");
    assert.match(r.stderr, expected);
    // The provider strips this prefix before showing the sentence.
    assert.match(r.stderr, /^error:\s/, "one recognisable envelope");
  }
});

await test("rename preserves CRLF", async () => {
  // The provider's matchEol() guard exists because a whole-document replace with
  // LF output would rewrite every line of a CRLF file. This is the measurement
  // that says the guard is currently a no-op rather than load-bearing.
  const crlf = DOC.replace(/\n/g, "\r\n");
  const r = await runCli(doc(crlf, { eol: vscode.EndOfLine.CRLF }), ["rename", "-", "#budget", "#spend"]);
  assert.ok(r);
  assert.equal(r.code, 0);
  assert.equal((crlf.match(/\r/g) || []).length, (r.stdout.match(/\r/g) || []).length,
    "as many CRs out as in");
});

await test("a document that already has an error cannot be renamed at all", async () => {
  // This is the behaviour the editor surfaces, and it is not obvious: the write
  // guard refuses ANY error in a .geml result, pre-existing ones included. So a
  // document with one unresolvable cross-document reference cannot have an
  // unrelated id renamed until that is fixed. The refusal is safe — nothing is
  // written — and the Problems panel already says what is broken, but a user who
  // presses F2 deserves the CLI's own sentence rather than silence.
  const broken = DOC.replace("b.geml#other", "no-such-file.geml#other");
  const r = await runCli(doc(broken), ["rename", "-", "#budget", "#spend"]);
  assert.ok(r);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /cannot resolve document/);
  assert.match(r.stderr, /not written/);
});

await test("listUnits returns the block index the outline and navigation read", async () => {
  const units = await listUnits(doc(DOC));
  assert.ok(Array.isArray(units), "an array, not an error envelope");
  const byAddress = new Map(units.map((u) => [u.address, u]));
  assert.ok(byAddress.has("#top"), "the heading");
  assert.ok(byAddress.has("#budget"), "the table");
  assert.equal(byAddress.get("#budget").kind, "table");
  // A heading spans its whole section — the outline's nesting and the folding
  // ranges are both built on that.
  const top = byAddress.get("#top");
  assert.ok(top.lines[1] > top.lines[0] + 1, `#top spans its section, got ${JSON.stringify(top.lines)}`);
});

await test("a second call for the same document version does not spawn again", async () => {
  // The cache is what keeps symbols and folding from costing two processes for
  // one answer. Identity of the returned promise is the observable proof.
  const d = doc(DOC, { version: 7 });
  const a = listUnits(d);
  const b = listUnits(d);
  assert.equal(a, b, "the same in-flight promise is shared");
  await a;
  assert.equal(listUnits(d), a, "and still served after it resolves");

  const newer = doc(DOC, { version: 8 });
  assert.notEqual(listUnits(newer), a, "a new version is not served from the old one");
});

// ---------------------------------------------------------------------------
// The reason cwd carries the directory: a path in argv reaches a shell
// ---------------------------------------------------------------------------

await test("a verb works in a directory whose name would break a command line", async () => {
  // This is the whole argument for runCliOnFile. Before it, the directory went
  // into argv, where on Windows `&` starts a second command and a space splits
  // the argument. Here the directory travels in cwd — never shell-parsed — and
  // only the (quoted) basename is an argument.
  const dir = mkdtempSync(path.join(tmpdir(), "geml&test dir-"));
  try {
    const name = "My Report.geml";
    writeFileSync(path.join(dir, name), DOC.replace("[[b.geml#other]]", "[[#top]]"), "utf8");

    const r = await runCliOnFile(vscode.Uri.file(path.join(dir, name)), ["list", name, "--json"]);
    assert.ok(r, "the CLI ran");
    assert.equal(r.code, 0, `exit 0; stderr was ${JSON.stringify(r.stderr)}`);
    const units = JSON.parse(r.stdout);
    assert.ok(units.some((u) => u.address === "#budget"), "and read the document that is really there");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("spawnCli refuses an argument that is not safe for a command line", async () => {
  // The last line of defence: a caller that forgot to check gets nothing back
  // rather than a shell invocation.
  const r = await spawnCli(["list", "a&b.geml", "--json"], { cwd: __dirname });
  assert.equal(r, null);
});

// ---------------------------------------------------------------------------
// revert: the contract the block-history picker is built on
// ---------------------------------------------------------------------------

await test("revert -o - prints the document and does not touch the file", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "geml-hist-"));
  try {
    const name = "a.geml";
    const file = path.join(dir, name);
    const uri = vscode.Uri.file(file);
    const v1 = ["%% geml 1.0", "", "=== table {#budget}", "| a |", "| - |", "| 1 |", "===", ""].join("\n");
    const v2 = v1.replace("| 1 |", "| 999 |");

    writeFileSync(file, v1, "utf8");
    assert.equal((await runCliOnFile(uri, ["history", "save", name])).code, 0);
    writeFileSync(file, v2, "utf8");
    // With a note, which is what the Save a Revision command passes.
    const saved = await runCliOnFile(uri, ["history", "save", name, "-m", "raised the figure"]);
    assert.equal(saved.code, 0, `-m is accepted; stderr was ${JSON.stringify(saved.stderr)}`);
    assert.match(saved.stdout, /^saved /, "and it reports the new revision id");

    // The picker reads this to build its list.
    const hist = await runCliOnFile(uri, ["history", "get", name, "--json"]);
    assert.equal(hist.code, 0);
    const revs = JSON.parse(hist.stdout);
    assert.equal(revs.length, 2, "two saved revisions");
    assert.equal(revs[0].offset, 0, "newest first, offset 0 is current");
    assert.equal(revs[1].offset, 1);

    // The block as it was, which is what the picker previews. `<rev>` is a
    // POSITIONAL here; `--rev` is `revert`'s flag and `history` rejects it —
    // pinned because passing it wrongly fails with exit 2 and an empty stdout,
    // which looks exactly like "this revision has no such block".
    const at = await runCliOnFile(uri, ["history", "get", name, revs[1].id]);
    assert.equal(at.code, 0, `history get <rev> is positional; stderr was ${JSON.stringify(at.stderr)}`);
    const bad = await runCliOnFile(uri, ["history", "get", name, "--rev", revs[1].id]);
    assert.equal(bad.code, 2, "and --rev is refused, so nothing silently reads the wrong revision");

    const block = await spawnCli(["get", "-", "#budget"], { cwd: dir, input: at.stdout });
    assert.match(block.stdout, /\| 1 \|/, "the older value");

    // And the revert itself: document on stdout, confirmation on stderr, file
    // untouched — which is what lets it be applied as an undoable editor edit.
    const out = await runCliOnFile(uri, ["revert", name, "#budget", "--rev", revs[1].id, "-o", "-"]);
    assert.equal(out.code, 0);
    assert.match(out.stdout, /\| 1 \|/, "stdout carries the reverted document");
    assert.match(out.stderr, /reverted #budget/, "and stderr the confirmation");
    assert.equal(readFileSync(file, "utf8"), v2, "the file on disk is unchanged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("find --json in a cwd answers with file plus address", async () => {
  // What the workspace-symbol provider maps onto SymbolInformation.
  const dir = mkdtempSync(path.join(tmpdir(), "geml-find-"));
  try {
    writeFileSync(path.join(dir, "one.geml"),
      ["%% geml 1.0", "", "=== table {#budget}", "| a |", "| - |", "| 1 |", "===", ""].join("\n"), "utf8");
    const r = await spawnCli(["find", "budget", ".", "--json"], { cwd: dir });
    assert.ok(r);
    const hits = JSON.parse(r.stdout);
    assert.ok(hits.length > 0, "found something");
    assert.equal(hits[0].file, "one.geml", "the file, relative to the searched directory");
    assert.equal(hits[0].address, "#budget", "an address, not a line number");
    assert.ok(Array.isArray(hits[0].lines), "with a line span to jump to");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

  console.log(`\n${passed} test(s) passed.`);
}

main().catch((e) => {
  console.error("not ok —", e.message);
  process.exit(1);
});
