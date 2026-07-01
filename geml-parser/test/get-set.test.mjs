// `geml get` / `geml set` — the addressable-block CLI: read or patch a single
// block by #id without loading the whole document. These tests pin the two
// guarantees the feature exists for: byte-exact extraction, and a splice that
// never corrupts the doc (re-parsed before it is written). Spawns the built
// CLI like cli.test.mjs; uses a throwaway temp dir like history.test.mjs.
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

function run(args, input) {
  const r = spawnSync(process.execPath, ["dist/geml.js", ...args], { input, encoding: "utf8" });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const dir = mkdtempSync(join(tmpdir(), "geml-getset-"));
const p = (name) => join(dir, name);
const write = (name, s) => { const f = p(name); writeFileSync(f, s); return f; };
const read = (f) => readFileSync(f, "utf8");

// A document with a heading, a raw code block, and a flow note — three id
// kinds, plus surrounding text whose bytes must survive an edit untouched.
const DOC =
  "# Intro {#intro}\n\n" +
  "Some prose here.\n\n" +
  '=== code {#snippet lang=py}\nprint("hi")\nx = 1\n===\n\n' +
  "=== note {#aside}\nan aside\n===\n";

// -- get -------------------------------------------------------------------

test("get prints a typed block's exact source span, byte-for-byte", () => {
  const f = write("g1.geml", DOC);
  const r = run(["get", f, "#snippet"]);
  assert.equal(r.code, 0);
  // The full fence-to-fence span, including the trailing newline after `===`.
  assert.equal(r.out, '=== code {#snippet lang=py}\nprint("hi")\nx = 1\n===\n');
});

test("get accepts the id with or without a leading '#'", () => {
  const f = write("g2.geml", DOC);
  assert.equal(run(["get", f, "#snippet"]).out, run(["get", f, "snippet"]).out);
});

test("get on a heading returns its single source line", () => {
  const f = write("g3.geml", DOC);
  const r = run(["get", f, "#intro"]);
  assert.equal(r.code, 0);
  assert.equal(r.out, "# Intro {#intro}\n");
});

test("get --json prints that one block's document-model node", () => {
  const f = write("g4.geml", DOC);
  const r = run(["get", f, "#snippet", "--json"]);
  assert.equal(r.code, 0);
  const node = JSON.parse(r.out);
  assert.equal(node.kind, "block");
  assert.equal(node.type, "code");
  assert.equal(node.id, "snippet");
  assert.deepEqual(node.raw, ['print("hi")', "x = 1"]);
  // It's ONE node, not the whole document envelope.
  assert.equal(node.kind === "document", false);
});

test("get --json finds a block nested inside a flow block", () => {
  const f = write("g5.geml", "=== note {#wrap}\nintro\n===== code {#deep}\ndeep body\n=====\n===\n");
  const r = run(["get", f, "#deep", "--json"]);
  assert.equal(r.code, 0);
  const node = JSON.parse(r.out);
  assert.equal(node.id, "deep");
  assert.deepEqual(node.raw, ["deep body"]);
});

test("get on an unknown id exits 1 with a clean 'no block with id' error", () => {
  const f = write("g6.geml", DOC);
  const r = run(["get", f, "#nope"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /no block with id `nope`/);
  assert.doesNotMatch(r.err, /node:|at Object/);
});

test("get reads the document from stdin via '-'", () => {
  const r = run(["get", "-", "#aside"], DOC);
  assert.equal(r.code, 0);
  assert.equal(r.out, "=== note {#aside}\nan aside\n===\n");
});

test("get raw still works when an unrelated block has a parse error", () => {
  // Raw extraction is span-based, so a broken block elsewhere doesn't block it.
  const f = write("g7.geml", "=== code {#good}\nok\n===\n\n=== code {#bad}\nunterminated\n");
  const r = run(["get", f, "#good"]);
  assert.equal(r.code, 0);
  assert.equal(r.out, "=== code {#good}\nok\n===\n");
});

test("get with no id is a usage error (exit 2) showing the subcommand usage", () => {
  const f = write("g8.geml", DOC);
  const r = run(["get", f]);
  assert.equal(r.code, 2);
  assert.match(r.err, /usage: geml get/);
});

test("get --help is a help request: usage to stdout, exit 0", () => {
  const r = run(["get", "--help"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /usage: geml get/);
  assert.doesNotMatch(r.err, /error:/);
});

// -- set -------------------------------------------------------------------

test("set replaces only the target block; everything else is byte-identical", () => {
  const f = write("s1.geml", DOC);
  const r = run(["set", f, "#snippet"], "=== code {#snippet lang=py}\nprint(\"bye\")\n===\n");
  assert.equal(r.code, 0);
  // The prose and the untouched blocks appear verbatim; only #snippet changed.
  const expected =
    "# Intro {#intro}\n\n" +
    "Some prose here.\n\n" +
    '=== code {#snippet lang=py}\nprint("bye")\n===\n\n' +
    "=== note {#aside}\nan aside\n===\n";
  assert.equal(r.out, expected);
});

test("set round-trips: get after set returns the new content", () => {
  const f = write("s2.geml", DOC);
  const nf = write("s2-new.geml", "=== code {#snippet lang=js}\nconsole.log(1)\n===\n");
  const w = run(["set", f, "#snippet", "--from", nf, "-o", f]);
  assert.equal(w.code, 0);
  assert.match(w.err, /wrote /);
  const g = run(["get", f, "#snippet"]);
  assert.equal(g.out, "=== code {#snippet lang=js}\nconsole.log(1)\n===\n");
  // The neighbours survived the in-place write.
  assert.match(read(f), /# Intro \{#intro\}/);
  assert.match(read(f), /=== note \{#aside\}/);
});

test("set reads new content from --from", () => {
  const f = write("s3.geml", DOC);
  const nf = write("s3-new.geml", "=== note {#aside}\nfresh aside\n===\n");
  const r = run(["set", f, "#aside", "--from", nf]);
  assert.equal(r.code, 0);
  assert.match(r.out, /fresh aside/);
});

test("set reads new content from stdin when --from is absent", () => {
  const f = write("s4.geml", DOC);
  const r = run(["set", f, "#aside"], "=== note {#aside}\npiped aside\n===\n");
  assert.equal(r.code, 0);
  assert.match(r.out, /piped aside/);
});

test("set -o writes in place and reports the path on stderr", () => {
  const f = write("s5.geml", DOC);
  const nf = write("s5-new.geml", "=== note {#aside}\nX marks it\n===\n");
  const r = run(["set", f, "#aside", "--from", nf, "-o", f]);
  assert.equal(r.code, 0);
  assert.match(r.err, /wrote /);
  const after = read(f);
  assert.match(after, /X marks it/);            // the new content is in the file
  assert.doesNotMatch(after, /an aside/);       // the old content is gone
});

test("set that would introduce a parse error exits 1 and writes nothing", () => {
  const f = write("s6.geml", DOC);
  const before = read(f);
  // A fence longer than any close in the doc → the block never terminates.
  const r = run(["set", f, "#snippet", "--from",
    write("s6-new.geml", "===== code {#snippet}\nno matching close fence\n"), "-o", f]);
  assert.equal(r.code, 1);
  assert.match(r.err, /would break the document|not written/);
  assert.equal(read(f), before, "file left byte-identical");
});

test("set that would create a duplicate id exits 1 and writes nothing", () => {
  const f = write("s7.geml", DOC);
  const before = read(f);
  // Replace #snippet with a block that claims #aside, which already exists.
  const r = run(["set", f, "#snippet"], "=== note {#aside}\ncollides\n===\n");
  assert.equal(r.code, 1);
  assert.match(r.err, /duplicate id|not written/);
  assert.equal(read(f), before);
});

test("set whose content drops the target id exits 1 and writes nothing", () => {
  const f = write("s8.geml", DOC);
  const before = read(f);
  const r = run(["set", f, "#snippet"], "=== code {#renamed}\nlost the id\n===\n");
  assert.equal(r.code, 1);
  assert.match(r.err, /removes id `snippet`|not written/);
  assert.equal(read(f), before);
});

test("set whose malformed content would swallow a neighbour block is rejected", () => {
  const f = write("s9.geml", DOC);
  const before = read(f);
  // An unterminated fence: a later `===` (from #aside) would absorb #aside's
  // opening line, silently deleting it. The all-ids guard must catch that.
  const r = run(["set", f, "#snippet"], "=== code {#snippet}\nunterminated\n");
  assert.equal(r.code, 1);
  assert.match(r.err, /drop block `#aside`|would break|not written/);
  assert.equal(read(f), before);
});

test("set on an unknown id exits 1 with a clean error", () => {
  const f = write("s10.geml", DOC);
  const r = run(["set", f, "#nope"], "=== note {#nope}\nx\n===\n");
  assert.equal(r.code, 1);
  assert.match(r.err, /no block with id `nope`/);
});

test("set reading the document from stdin without --from is a usage error (exit 2)", () => {
  const r = run(["set", "-", "#snippet"], "some content\n");
  assert.equal(r.code, 2);
  assert.match(r.err, /needs --from/);
});

test("set with empty stdin content exits 1 (no replacement)", () => {
  const f = write("s11.geml", DOC);
  const r = run(["set", f, "#snippet"], "");
  assert.equal(r.code, 1);
  assert.match(r.err, /no replacement content/);
});

test("set with no id is a usage error (exit 2)", () => {
  const f = write("s12.geml", DOC);
  const r = run(["set", f], "x\n");
  assert.equal(r.code, 2);
  assert.match(r.err, /usage: geml set/);
});

test("set preserves a file with no trailing newline when editing its last block", () => {
  const f = write("s13.geml", "# H {#h}\n\n=== code {#last}\nold\n===");   // no final \n
  const r = run(["set", f, "#last"], "=== code {#last}\nnew\n===");        // no final \n
  assert.equal(r.code, 0);
  assert.equal(r.out, "# H {#h}\n\n=== code {#last}\nnew\n===");           // still no final \n
});

test("--help lists get and set", () => {
  const r = run(["--help"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /geml get /);
  assert.match(r.out, /geml set /);
});

// The --json error envelope path is shared, but confirm it holds for get too.
test("get --json turns an unknown id into a parseable {error, code} envelope", () => {
  const f = write("s14.geml", DOC);
  const r = run(["get", f, "#nope", "--json"]);
  assert.equal(r.code, 1);
  const env = JSON.parse(r.err.trim());
  assert.match(env.error, /no block with id `nope`/);
  assert.equal(env.code, 1);
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} test(s) passed.`);
