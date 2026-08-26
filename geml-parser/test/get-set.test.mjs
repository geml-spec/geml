// `geml get` / `geml set` — the addressable-block CLI: read or patch a single
// block by #id without loading the whole document. These tests pin the two
// guarantees the feature exists for: byte-exact extraction, and a splice that
// never corrupts the doc (re-parsed before it is written). Spawns the built
// CLI like cli.test.mjs; uses a throwaway temp dir like history.test.mjs.
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

function run(args, input) {
  // timeout: a blocked CLI must fail loudly, not hang the job (see cli.test).
  const r = spawnSync(process.execPath, ["dist/geml.js", ...args], { input, encoding: "utf8", timeout: 60_000 });
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

test("get on a heading returns its whole section (to end-of-scope here)", () => {
  const f = write("g3.geml", DOC);
  const r = run(["get", f, "#intro"]);
  assert.equal(r.code, 0);
  // No same-or-higher heading follows, so #intro's section runs to the end.
  assert.equal(r.out, DOC);
});

// A two-section document with a nested code block whose body has a `#` line —
// the section-span cases share it.
const SECDOC =
  "# A {#a}\n\nintro prose\n\n" +
  "=== code {#c}\n# a comment, not a heading\nx = 1\n===\n\n" +
  "tail prose\n\n" +
  "# B {#b}\n\nb prose\n";
const SECTION_A =
  "# A {#a}\n\nintro prose\n\n" +
  "=== code {#c}\n# a comment, not a heading\nx = 1\n===\n\n" +
  "tail prose\n\n";

test("a heading's section ends at the next same-level heading", () => {
  const f = write("sec1.geml", SECDOC);
  assert.equal(run(["get", f, "#a"]).out, SECTION_A);
  assert.equal(run(["get", f, "#b"]).out, "# B {#b}\n\nb prose\n");
});

test("a deeper heading is part of the section; same-or-higher ends it", () => {
  const f = write("sec2.geml", "# A {#a}\n\n## Sub {#sub}\n\nsub prose\n\n# C {#cc}\nend\n");
  assert.equal(run(["get", f, "#a"]).out, "# A {#a}\n\n## Sub {#sub}\n\nsub prose\n\n");
  assert.equal(run(["get", f, "#sub"]).out, "## Sub {#sub}\n\nsub prose\n\n");
});

test("a `#` line inside a code body is not a section boundary", () => {
  const f = write("sec3.geml", SECDOC);
  // If the comment line ended the section, #a would stop before `x = 1`.
  assert.ok(run(["get", f, "#a"]).out.includes("tail prose"));
});

test("get on a nested block inside a section still returns just that block", () => {
  const f = write("sec4.geml", SECDOC);
  assert.equal(run(["get", f, "#c"]).out, "=== code {#c}\n# a comment, not a heading\nx = 1\n===\n");
});

test("a heading section at end-of-file without a trailing newline round-trips", () => {
  const f = write("sec5.geml", "# A {#a}\npara");
  assert.equal(run(["get", f, "#a"]).out, "# A {#a}\npara");
  const r = run(["set", f, "#a", "-o", f], "# A {#a}\nnew para");
  assert.equal(r.code, 0);
  assert.equal(read(f), "# A {#a}\nnew para");
});

test("set on a section replaces it whole; the other section is byte-identical", () => {
  const f = write("sec6.geml", SECDOC);
  // The replacement supplies the section's trailing blank line itself: the
  // span it replaces ran through that blank line (up to the `# B` boundary).
  const repl = "# A {#a}\n\nrewritten\n\n=== code {#c}\ny = 2\n===\n\n";
  const r = run(["set", f, "#a", "-o", f], repl);
  assert.equal(r.code, 0);
  assert.equal(read(f), repl + "# B {#b}\n\nb prose\n");
  assert.equal(run(["get", f, "#a"]).out, repl);
});

test("an interpolated heading's auto-slug id is addressable by raw get (parity with the parser)", () => {
  const f = write("sec24.geml", "=== meta\ntitle = GEML\n===\n\n# {{title}} Setup\n\nprose\n");
  const r = run(["get", f, "#title-setup"]);   // the id the parser registers (from raw text)
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "# {{title}} Setup\n\nprose\n");
  assert.equal(run(["get", f, "#geml-setup"]).code, 1); // the interpolated text phantom must not exist
});

test("a CR-only (lone \\r) file: spans and bytes align for get and set", () => {
  const f = write("sec25.geml", "# A {#a}\rpara\r# B {#b}\rx\r");
  assert.equal(run(["get", f, "#a"]).out, "# A {#a}\rpara\r");
  assert.equal(run(["get", f, "#b"]).out, "# B {#b}\rx\r");
  const r = run(["set", f, "#b", "-o", "-"], "# B {#b}\nnew x\n");
  assert.equal(r.code, 0);
  assert.equal(r.out, "# A {#a}\rpara\r# B {#b}\nnew x\n"); // bytes before the span untouched
});

test("an unterminated fence swallows the section boundary on BOTH sides", () => {
  const f = write("sec8.geml", "# A {#a}\n\n=== code {#c}\nnever closed\n\n# B {#b}\nb prose\n");
  // The fence never closes, so `# B` is code body: #a's section runs to EOF …
  assert.equal(run(["get", f, "#a"]).out, "# A {#a}\n\n=== code {#c}\nnever closed\n\n# B {#b}\nb prose\n");
  // … the swallowed heading is not addressable, and raw and --json AGREE …
  assert.equal(run(["get", f, "#b"]).code, 1);
  assert.equal(run(["get", f, "#b", "--json"]).code, 1);
  // … and the unterminated block's own span runs to EOF, like the parser's body.
  assert.equal(run(["get", f, "#c"]).out, "=== code {#c}\nnever closed\n\n# B {#b}\nb prose\n");
});

test("a `# h1` inside a note body neither ends an outer `## h2` section nor escapes the note", () => {
  const f = write("sec9.geml", "## Outer {#outer}\n\n=== note {#nb}\n# Big {#big}\nbig prose\n===\n\ntail\n");
  assert.equal(run(["get", f, "#outer"]).out, "## Outer {#outer}\n\n=== note {#nb}\n# Big {#big}\nbig prose\n===\n\ntail\n");
  assert.equal(run(["get", f, "#big"]).out, "# Big {#big}\nbig prose\n");
});

test("a labeled `=== #id` close inside a section is honored by the boundary scan", () => {
  const f = write("sec11.geml", "# A {#a}\n\n=== note {#n}\nnote body\n===== #n\n\ntail\n\n# B {#b}\nx\n");
  assert.equal(run(["get", f, "#a"]).out, "# A {#a}\n\n=== note {#n}\nnote body\n===== #n\n\ntail\n\n");
  assert.equal(run(["get", f, "#n"]).out, "=== note {#n}\nnote body\n===== #n\n");
});

test("get returns a CRLF section byte-exact; set keeps the WHOLE document CRLF", () => {
  const f = write("sec12.geml", "# A {#a}\r\n\r\nA prose\r\n\r\n# B {#b}\r\nb prose\r\n");
  assert.equal(run(["get", f, "#a"]).out, "# A {#a}\r\n\r\nA prose\r\n\r\n");
  const r = run(["set", f, "#a", "-o", "-"], "# A {#a}\nnew prose\n\n");
  assert.equal(r.code, 0);
  // An LF replacement ADOPTS the document's CRLF: bytes outside the span are
  // untouched (as always), and the spliced block no longer leaves the file half
  // CRLF / half LF. Content routinely arrives LF (stdin, or a history revision,
  // which the sidecar stores normalized), so forcing LF in silently mixed the
  // endings of every CRLF document a mutation touched.
  assert.equal(r.out, "# A {#a}\r\nnew prose\r\n\r\n# B {#b}\r\nb prose\r\n");
});

test("set REFUSES multi-block content (two same-level sections) — that is `add`'s job", () => {
  const f = write("sec13.geml", SECDOC);
  const repl = "# A {#a}\n\nshort now\n\n=== code {#c}\nx = 1\n===\n\n# A2 {#a2}\n\nsplit off\n\n";
  const r = run(["set", f, "#a", "-o", f], repl);
  assert.equal(r.code, 1);
  assert.match(r.err, /multiple blocks|one block/);
  assert.equal(read(f), SECDOC); // nothing written
});

test("duplicate heading slugs: get still addresses the FIRST section (first wins)", () => {
  const f = write("sec14.geml", "# Intro\nfirst body\n\n# Intro\nsecond body\n");
  assert.equal(run(["get", f, "#intro"]).out, "# Intro\nfirst body\n\n");
  assert.equal(JSON.parse(run(["get", f, "#intro", "--json"]).out).blocks[1].text, "first body");
  const r = run(["set", f, "#intro"], "# Intro\npatched\n\n"); // doc itself is broken: refused
  assert.equal(r.code, 1);
  assert.match(r.err, /duplicate id/);
});

test("set NORMALIZES the content's heading id to the target (#zzz → #a), keeping the address", () => {
  const f = write("sec16.geml", SECDOC);
  const r = run(["set", f, "#a", "-o", f], "# Renamed {#zzz}\n\nintro prose\n\n=== code {#c}\nx = 1\n===\n\ntail\n\n");
  assert.equal(r.code, 0, r.err);
  // #a survives as the address; only the heading TEXT changed; #zzz never lands.
  assert.match(run(["get", f, "#a", "--head"]).out, /# Renamed \{#a\}/);
  assert.equal(run(["get", f, "#zzz"]).code, 1);
  assert.match(run(["get", f, "#c"]).out, /=== code \{#c\}/); // nested id preserved
});

test("a `#`-without-space line is a paragraph, not a heading or boundary", () => {
  const f = write("sec17.geml", "# A {#a}\n#foo not a heading\n#5 reasons\n\n# B {#b}\nx\n");
  assert.equal(run(["get", f, "#a"]).out, "# A {#a}\n#foo not a heading\n#5 reasons\n\n");
});

test("set on the first heading leaves a leading meta block byte-identical", () => {
  const f = write("sec18.geml", "=== meta\ntitle = X\n===\n\n# First {#first}\nbody\n\n# B {#b}\nx\n");
  const r = run(["set", f, "#first", "-o", "-"], "# First {#first}\nnew body\n\n");
  assert.equal(r.code, 0);
  assert.equal(r.out, "=== meta\ntitle = X\n===\n\n# First {#first}\nnew body\n\n# B {#b}\nx\n");
});

test("a close fence of the wrong length is body; the boundary scan agrees with the parser", () => {
  const f = write("sec19.geml", "# A {#a}\n=== code {#c}\nx\n====\nstill body\n===\n\n# B {#b}\ny\n");
  assert.equal(run(["get", f, "#a"]).out, "# A {#a}\n=== code {#c}\nx\n====\nstill body\n===\n\n");
  assert.equal(run(["get", f, "#c"]).out, "=== code {#c}\nx\n====\nstill body\n===\n");
});

test("set on a heading section inside a note body splices only those lines", () => {
  const f = write("sec20.geml", "# Top {#top}\n\n=== note {#nb}\npreamble\n## Inner {#inner}\ninner prose\n===\n\ntail\n");
  const r = run(["set", f, "#inner", "-o", "-"], "## Inner {#inner}\nrewritten inner\n");
  assert.equal(r.code, 0);
  assert.equal(r.out, "# Top {#top}\n\n=== note {#nb}\npreamble\n## Inner {#inner}\nrewritten inner\n===\n\ntail\n");
});

test("a {hidden} heading is still addressable as a section", () => {
  const f = write("sec21.geml", "# Secret {#sec hidden}\nhidden body\n\n# B {#b}\nx\n");
  assert.equal(run(["get", f, "#sec"]).out, "# Secret {#sec hidden}\nhidden body\n\n");
});

test("set on a section that IS the entire file replaces the whole document", () => {
  const f = write("sec22.geml", "# Only {#only}\n\neverything\n");
  const r = run(["set", f, "#only", "-o", "-"], "# Only {#only}\n\nreplaced everything\n");
  assert.equal(r.code, 0);
  assert.equal(r.out, "# Only {#only}\n\nreplaced everything\n");
});

// -- get --json on a heading: the SECTION envelope ---------------------------

// Every id reachable inside a model node — the parity metric: the raw side
// reports parse(<raw slice>).ids, the json side must cover the same ids in
// the same order.
const idsIn = (node) => {
  const out = [];
  const walk = (b) => {
    if (b.id) out.push(b.id);
    for (const c of b.children ?? []) walk(c);
    for (const it of b.items ?? []) for (const c of it.children ?? []) walk(c);
  };
  walk(node);
  return out;
};

test("get --json on a heading returns a section envelope matching the raw span", () => {
  const f = write("secj1.geml", SECDOC);
  const env = JSON.parse(run(["get", f, "#a", "--json"]).out);
  assert.equal(env.kind, "section");
  assert.equal(env.id, "a");
  assert.equal(env.level, 1);
  assert.equal(env.blocks[0].kind, "heading");
  assert.equal(env.blocks[0].id, "a");
  // raw <-> json parity guard: both sides cover exactly the same ids, in order.
  const raw = run(["get", f, "#a"]).out;
  const rawIds = JSON.parse(run(["-"], raw).out).ids;
  assert.deepEqual(env.blocks.flatMap(idsIn), rawIds);
});

test("--json section: a deeper heading is inside blocks; same-level ends it", () => {
  const f = write("secj2.geml", "# A {#a}\n\n## Sub {#sub}\n\nsub prose\n\n# C {#cc}\nend\n");
  const env = JSON.parse(run(["get", f, "#a", "--json"]).out);
  const ids = env.blocks.flatMap(idsIn);
  assert.ok(ids.includes("sub"), "deeper heading is part of the section");
  assert.ok(!ids.includes("cc"), "same-level heading ends the section");
});

test("--json section: a heading directly before a same-level heading is [heading] only", () => {
  const f = write("secj3.geml", "# A {#a}\n# B {#b}\n");
  const env = JSON.parse(run(["get", f, "#a", "--json"]).out);
  assert.equal(env.blocks.length, 1);
  assert.equal(env.blocks[0].kind, "heading");
});

test("--json on a heading inside a note body returns its envelope; parity holds", () => {
  const f = write("sec10.geml", "# Top {#top}\n\n=== note {#nb}\npreamble\n## Inner {#inner}\ninner prose\nmore inner\n===\n\ntail after note\n");
  const raw = run(["get", f, "#inner"]).out;
  assert.equal(raw, "## Inner {#inner}\ninner prose\nmore inner\n");
  const env = JSON.parse(run(["get", f, "#inner", "--json"]).out);
  assert.equal(env.kind, "section");
  assert.equal(env.id, "inner");
  assert.equal(env.level, 2);
  assert.deepEqual(env.blocks.flatMap(idsIn), JSON.parse(run(["-"], raw).out).ids);
});

test("--json parity holds (order-sensitive) when the section contains footnote defs", () => {
  const f = write("sec15.geml", "# A {#a}\n\nsee[^fn1] and[^fn2]\n\n=== note {#fn1}\nfirst note\n===\n\n=== code {#c}\nx\n===\n\n=== note {#fn2}\nsecond note\n===\n\n# B {#b}\nx\n");
  const raw = run(["get", f, "#a"]).out;
  const rawIds = JSON.parse(run(["-"], raw).out).ids;
  assert.deepEqual(JSON.parse(run(["get", f, "#a", "--json"]).out).blocks.flatMap(idsIn), rawIds);
  assert.deepEqual(rawIds, ["a", "fn1", "c", "fn2"]);
});

// -- --head: narrow get/set/revert to any id's HEAD line ---------------------
// (head line = first line of the span: heading line, opening fence, [^id]: line)

test("get --head returns the single head line of ANY id type", () => {
  const f = write("hd1.geml", SECDOC);
  assert.equal(run(["get", "--head", f, "#a"]).out, "# A {#a}\n");       // heading
  assert.equal(run(["get", "--head", f, "#c"]).out, "=== code {#c}\n"); // typed block
});

test("get --json with --head/--body is a usage error, not a half-honoured flag", () => {
  // Selector design §7 / §9 change 3: this combination used to work on a heading
  // (suppressing the section envelope) and be silently ignored on a block. Both
  // readings are gone — --json answers with the model node, which has no
  // sub-node for one part of a block, so asking for both is a usage error.
  const f = write("hd2.geml", SECDOC);
  for (const part of ["--head", "--body"]) {
    const r = run(["get", part, "--json", f, "#a"]);
    assert.equal(r.code, 2, `${part} + --json must exit 2`);
    assert.match(r.err, /--json cannot be combined with/);
  }
});

test("set --head renames the heading; section prose and nested ids stay byte-identical", () => {
  const f = write("hd3.geml", SECDOC);
  const r = run(["set", "--head", f, "#a", "-o", f], "# A renamed {#a}\n");
  assert.equal(r.code, 0, r.err);
  assert.equal(read(f), "# A renamed {#a}" + SECDOC.slice("# A {#a}".length));
  assert.equal(run(["get", f, "#c"]).out, "=== code {#c}\n# a comment, not a heading\nx = 1\n===\n");
});

const TBLDOC = "=== table {#tbl}\n| a | b |\n|---|---|\n| 1 | 2 |\n===\n";

test("get/set --head on a typed block: the opening fence line only (edit attributes)", () => {
  const f = write("hd4.geml", TBLDOC);
  assert.equal(run(["get", "--head", f, "#tbl"]).out, "=== table {#tbl}\n");
  const r = run(["set", "--head", f, "#tbl", "-o", f], "=== table {#tbl caption=\"Data\"}\n");
  assert.equal(r.code, 0, r.err);
  assert.equal(read(f), "=== table {#tbl caption=\"Data\"}\n| a | b |\n|---|---|\n| 1 | 2 |\n===\n");
  assert.equal(run(["check", f]).code, 0);
});

test("set --head that breaks fence pairing is rejected (longer open fence, close unchanged)", () => {
  const f = write("hd5.geml", TBLDOC);
  const longer = run(["set", "--head", f, "#tbl", "-o", f], "==== table {#tbl}\n"); // open 4, close still 3
  assert.equal(longer.code, 1);
  assert.match(longer.err, /would break the document|removes id/);
  assert.equal(read(f), TBLDOC); // nothing written
});

test("set --head NORMALIZES an anonymous head back to the target id (never drops it)", () => {
  const f = write("hd5b.geml", TBLDOC);
  const r = run(["set", "--head", f, "#tbl", "-o", f], "=== table\n"); // no {#tbl} — normalized in
  assert.equal(r.code, 0, r.err);
  assert.equal(read(f), TBLDOC); // `=== table` normalized to `=== table {#tbl}` == the original head
});

test("get --head on a footnote definition is a no-op narrowing", () => {
  const f = write("hd6.geml", "see it[^fn]\n\n[^fn]: the source note\n");
  assert.equal(run(["get", "--head", f, "#fn"]).out, "[^fn]: the source note\n");
  assert.equal(run(["get", f, "#fn"]).out, "[^fn]: the source note\n"); // already one line
});

test("get --json on a typed-block id is still the single model node", () => {
  const f = write("secj4.geml", SECDOC);
  const node = JSON.parse(run(["get", f, "#c", "--json"]).out);
  assert.equal(node.kind, "block");
  assert.equal(node.id, "c");
});

test("set on a section that drops a nested id does it and names what it dropped", () => {
  // This used to be refused. Refusing left the region uneditable whenever it
  // held a named block, and said nothing at all when the block was unnamed —
  // so the rule is now `delete`'s: carry out the removal, report it, and leave
  // `geml revert` as the way back.
  const f = write("sec7.geml", SECDOC);
  const r = run(["set", f, "#a", "-o", f], "# A {#a}\n\nprose only, code gone\n");
  assert.equal(r.code, 0);
  assert.match(r.err, /dropped .*#c/, "the caller is told which block went");
  assert.match(r.err, /geml revert/);
  assert.doesNotMatch(read(f), /#c/);
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

test("get with no id lists every addressable id (text), exit 0", () => {
  const f = write("g8.geml", DOC);
  const r = run(["get", f]);
  assert.equal(r.code, 0);
  // One line per unit, with its kind (and a heading's level/text).
  // The range sits between the level and the text — every row carries one now.
  assert.match(r.out, /#intro\s+heading\s+h1\s+L\d+-\d+\s+Intro/);
  assert.match(r.out, /#snippet\s+code/);
  assert.match(r.out, /#aside\s+note/);
});

test("get with no id on a document that has no ids says so on stderr, exit 0", () => {
  const f = write("g8e.geml", "just a paragraph, nothing addressable\n");
  const r = run(["get", f]);
  assert.equal(r.code, 0);
  assert.equal(r.out, "");
  assert.match(r.err, /no addressable blocks/);
});

test("get with no id --json lists ids as a structured array", () => {
  const f = write("g8j.geml", DOC);
  const r = run(["get", f, "--json"]);
  assert.equal(r.code, 0);
  const rows = JSON.parse(r.out);
  assert.ok(Array.isArray(rows));
  // Every row carries the ADDRESS to paste back (§6.2) plus the line range —
  // an id-bearing row keeps `id`, and only an id-less one is flagged `anon`.
  assert.deepEqual(rows.find((x) => x.id === "snippet"),
    { address: "#snippet", id: "snippet", kind: "code", lines: [5, 8] });
  // A heading's range is its whole SECTION — nothing terminates #intro, so it
  // runs to the end of the document, the same span `get #intro` prints.
  assert.deepEqual(rows.find((x) => x.id === "intro"),
    { address: "#intro", id: "intro", kind: "heading", level: 1, text: "Intro", lines: [1, 13] });
  assert.ok(rows.every((x) => x.anon === undefined), "DOC names every block");
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
  const r = run(["set", f, "#snippet", "-o", "-"], "=== code {#snippet lang=py}\nprint(\"bye\")\n===\n");
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
  const w = run(["set", f, "#snippet", "--in", nf, "-o", f]);
  assert.equal(w.code, 0);
  assert.match(w.err, /wrote /);
  const g = run(["get", f, "#snippet"]);
  assert.equal(g.out, "=== code {#snippet lang=js}\nconsole.log(1)\n===\n");
  // The neighbours survived the in-place write.
  assert.match(read(f), /# Intro \{#intro\}/);
  assert.match(read(f), /=== note \{#aside\}/);
});

test("set reads new content from --in", () => {
  const f = write("s3.geml", DOC);
  const nf = write("s3-new.geml", "=== note {#aside}\nfresh aside\n===\n");
  const r = run(["set", f, "#aside", "--in", nf, "-o", "-"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /fresh aside/);
});

test("set reads new content from stdin when --in is absent", () => {
  const f = write("s4.geml", DOC);
  const r = run(["set", f, "#aside", "-o", "-"], "=== note {#aside}\npiped aside\n===\n");
  assert.equal(r.code, 0);
  assert.match(r.out, /piped aside/);
});

test("set -o writes in place and reports the path on stderr", () => {
  const f = write("s5.geml", DOC);
  const nf = write("s5-new.geml", "=== note {#aside}\nX marks it\n===\n");
  const r = run(["set", f, "#aside", "--in", nf, "-o", f]);
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
  const r = run(["set", f, "#snippet", "--in",
    write("s6-new.geml", "===== code {#snippet}\nno matching close fence\n"), "-o", f]);
  assert.equal(r.code, 1);
  assert.match(r.err, /would break the document|not written/);
  assert.equal(read(f), before, "file left byte-identical");
});

test("--root makes a document editable whose cross-doc links only resolve from a wider root", () => {
  // The shape this comes from: spec/in_geml_format/*.geml sit one directory below
  // the .md they link to, so `../GEML-spec_CN.md` resolves from the repo root and
  // nowhere else. The write guard re-parses before writing, and without a root it
  // read its own blind spot as breakage — so those documents could not be edited
  // by `set` AT ALL, not even by writing a block back unchanged, while
  // `check --root .` called them clean. The guard was refusing the parser's
  // ignorance rather than a broken result.
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "sibling.md"), "# Sibling\n");
  const f = join(dir, "sub", "r1.geml");
  const doc = "=== meta\ntitle = \"T\"\n===\n\n# H {#h}\n\nSee [sibling](../sibling.md).\n\n=== note {#n}\nbody\n===\n";
  writeFileSync(f, doc);
  const blk = write("r1-blk.geml", "=== note {#n}\nrewritten\n===\n");

  // This is a `.geml` document, so the guard stays strict: inside GEML, "every
  // reference resolves" is the contract, and a document that stops honouring it
  // is locked until repaired (or until `--root` shows the parser where to look).
  // A `.md` target is judged only on what the edit itself breaks — see
  // "a defect the document already had does not block an unrelated edit".
  const bare = run(["set", f, "#n", "--in", blk, "-o", "-"]);
  assert.equal(bare.code, 1, "without a root the link is unresolvable, so the write is refused");
  assert.match(bare.err, /cannot resolve document/);

  const rooted = run(["set", f, "#n", "--in", blk, "--root", dir, "-o", "-"]);
  assert.equal(rooted.code, 0, `--root resolves it: ${rooted.err}`);
  assert.match(rooted.out, /rewritten/);
  assert.equal(readFileSync(f, "utf8"), doc, "-o - left the file alone");

  // Every write verb takes it, not just `set`.
  for (const args of [
    ["replace", f, "body", "body2", "--root", dir, "-o", "-"],
    ["delete", f, "#n", "--root", dir, "-o", "-"],
    ["rename", f, "#n", "#n2", "--root", dir, "-o", "-"],
    // A fresh id: appending `#n` again would be a real duplicate-id refusal,
    // which says nothing about --root.
    ["add", f, "--append", "--in", write("r1-add.geml", "=== note {#n3}\nadded\n===\n"), "--root", dir, "-o", "-"],
  ]) {
    const r = run(args);
    assert.equal(r.code, 0, `${args[0]} accepts --root: ${r.err}`);
  }

  // `--root` with nothing after it is a usage error, as it is on `check`.
  const bad = run(["set", f, "#n", "--in", blk, "--root"]);
  assert.equal(bad.code, 2, "a flag that needs a value says so");
  assert.match(bad.err, /--root needs a directory/);
});

test("set NORMALIZES the content id to the target — a source id that would collide is rewritten, not rejected", () => {
  const f = write("s7.geml", DOC);
  const r = run(["set", f, "#snippet", "-o", "-"], "=== note {#aside}\ncollides\n===\n");
  assert.equal(r.code, 0, r.err);
  // #snippet's slot now holds the note (id normalized to #snippet); the doc's own #aside is untouched.
  assert.match(r.out, /=== note \{#snippet\}\ncollides\n===/);
  assert.match(r.out, /=== note \{#aside\}\nan aside\n===/);
});

test("set can never drop the target id — a differing content id is normalized to it", () => {
  const f = write("s8.geml", DOC);
  const r = run(["set", f, "#snippet", "-o", "-"], "=== code {#renamed}\nrewired\n===\n");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /=== code \{#snippet\}\nrewired\n===/);
  assert.doesNotMatch(r.out, /#renamed/);
});

test("set whose malformed content swallows a neighbour block never does it silently", () => {
  const f = write("s9.geml", DOC);
  // An unterminated fence: a later `===` (from #aside) absorbs #aside's opening
  // line. The result can still parse, so this is the case the report exists for
  // — the removal was nobody's intent, and the only defence is being told.
  const r = run(["set", f, "#snippet"], "=== code {#snippet}\nunterminated\n");
  assert.match(r.err, /drop|would break|not written/, "refused, or carried out and named — never quiet");
  if (r.code === 0) assert.match(r.err, /geml revert/, "and the way back is offered");
});

test("set on an unknown id exits 1 with a clean error", () => {
  const f = write("s10.geml", DOC);
  const r = run(["set", f, "#nope"], "=== note {#nope}\nx\n===\n");
  assert.equal(r.code, 1);
  assert.match(r.err, /no block with id `nope`/);
});

test("set reading the document from stdin without --in is a usage error (exit 2)", () => {
  const r = run(["set", "-", "#snippet"], "some content\n");
  assert.equal(r.code, 2);
  assert.match(r.err, /needs --in/);
});

test("set with empty stdin content exits 1 (no replacement)", () => {
  const f = write("s11.geml", DOC);
  const r = run(["set", f, "#snippet"], "");
  assert.equal(r.code, 1);
  assert.match(r.err, /no replacement content/);
});

test("set with no selector is a usage error (exit 2) pointing at geml get", () => {
  const f = write("s12.geml", DOC);
  const r = run(["set", f], "x\n");
  assert.equal(r.code, 2);
  assert.match(r.err, /no selector given.*geml get/);
});

test("set preserves a file with no trailing newline when editing its last block", () => {
  const f = write("s13.geml", "# H {#h}\n\n=== code {#last}\nold\n===");   // no final \n
  const r = run(["set", f, "#last", "-o", "-"], "=== code {#last}\nnew\n===");        // no final \n
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

// -- set: output target (file -> in place, stdin -> stdout, -o/-o - redirect) -

const OTDOC = "# A {#a}\nold body\n";

test("set on a real file with no -o writes in place; stdout is empty", () => {
  const f = write("ot1.geml", OTDOC);
  const g = write("ot1-new.geml", "# A {#a}\nnew body\n");
  const r = run(["set", f, "#a", "--in", g]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "");
  assert.match(read(f), /new body/);
});

test("set on stdin ('-') with no -o writes the updated doc to stdout", () => {
  const g = write("ot2-new.geml", "# A {#a}\nnew body\n");
  const r = run(["set", "-", "#a", "--in", g], OTDOC);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /new body/);
});

test("set -o - forces stdout even for a real file input; the file is untouched", () => {
  const f = write("ot3.geml", OTDOC);
  const g = write("ot3-new.geml", "# A {#a}\nnew body\n");
  const r = run(["set", f, "#a", "--in", g, "-o", "-"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /new body/);
  assert.equal(read(f), OTDOC, "file untouched when -o - redirects to stdout");
});

// -- text: the addressable-prose container get/set exists for ---------------

const TEXTDOC = "# H {#h}\n\n=== text {#intro .lead}\nHello **world**.\n\nSecond para.\n===\n\ntrailing prose\n";

test("get returns a `text` block's full fence-to-fence span", () => {
  const f = write("t1.geml", TEXTDOC);
  const r = run(["get", f, "#intro"]);
  assert.equal(r.code, 0);
  assert.equal(r.out, "=== text {#intro .lead}\nHello **world**.\n\nSecond para.\n===\n");
});

test("set -o round-trips a `text` block; the rest of the doc is byte-identical", () => {
  const f = write("t2.geml", TEXTDOC);
  const r = run(["set", f, "#intro", "-o", f], "=== text {#intro .lead}\nRewritten prose.\n===\n");
  assert.equal(r.code, 0, r.err);
  const after = read(f);
  assert.match(after, /Rewritten prose\./);
  assert.match(after, /^# H \{#h\}/, "heading untouched");
  assert.match(after, /trailing prose/, "tail untouched");
});

test("set on a `text` block: an anonymous head is normalized to the target id (not dropped)", () => {
  const f = write("t3.geml", TEXTDOC);
  const r = run(["set", f, "#intro", "-o", f], "=== text\nanonymous now\n===\n");
  assert.equal(r.code, 0, r.err);
  assert.match(run(["get", f, "#intro"]).out, /=== text \{#intro\}\nanonymous now\n===/);
});

// -- set --in FILE#id : one-block fragment sourcing -------------------------
// `--in FILE#src` supplies ONE block's exact source bytes (what `geml get FILE
// #src` prints), then NORMALIZES that block's id to the target #t before the
// splice: the source id is irrelevant — copying #src's content into #t's slot
// always lands as #t (so a source id that matches an existing block never
// collides). Same id = a clean content swap.

test("set --in FILE#id pulls that one block (same id) from another file", () => {
  const tf = write("frag-doc.geml", "# Doc {#doc}\n\n=== note {#license}\nold license\n===\n\ntail para\n");
  write("frag-template.geml", "junk head\n\n=== note {#license}\nNEW LICENSE TEXT\n===\n\nmore junk\n");
  const r = run(["set", tf, "#license", "--in", `${p("frag-template.geml")}#license`, "-o", tf]);
  assert.equal(r.code, 0, r.err);
  const got = run(["get", tf, "#license"]).out;
  assert.match(got, /NEW LICENSE TEXT/);
  assert.doesNotMatch(got, /old license/);
  assert.match(run(["get", tf, "#doc"]).out, /# Doc/, "other blocks untouched");
});

test("set --in FILE#id sourcing the SAME file (same id) is a clean no-op-safe swap", () => {
  const tf = write("frag-same.geml", "=== note {#a}\nbody\n===\n\n=== note {#b}\nother\n===\n");
  const r = run(["set", tf, "#a", "--in", `${tf}#a`, "-o", "-"]); // content of #a -> #a: identical
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /=== note \{#a\}\nbody\n===/);
});

test("set --in FILE#missing (id absent in the source file) exits 1, writes nothing", () => {
  const before = "=== note {#a}\nbody\n===\n";
  const tf = write("frag-miss.geml", before);
  write("frag-src2.geml", "=== note {#x}\nx\n===\n");
  const r = run(["set", tf, "#a", "--in", `${p("frag-src2.geml")}#nope`, "-o", tf]);
  assert.equal(r.code, 1);
  assert.match(r.err, /no block with id `nope`/);
  assert.equal(read(tf), before, "target unchanged after failure");
});

test("set --in FILE#src normalizes the extracted block's id to the target (copy-into-slot)", () => {
  const before = "=== note {#target}\nt\n===\n\n=== note {#other}\no\n===\n";
  const tf = write("frag-conflict.geml", before);
  write("frag-src3.geml", "=== note {#other}\nNEW OTHER\n===\n");
  // #other's CONTENT is copied into #target's slot, its id normalized to #target;
  // the doc's own #other is untouched — no collision.
  const r = run(["set", tf, "#target", "--in", `${p("frag-src3.geml")}#other`, "-o", tf]);
  assert.equal(r.code, 0, r.err);
  assert.match(run(["get", tf, "#target"]).out, /=== note \{#target\}\nNEW OTHER\n===/);
  assert.match(run(["get", tf, "#other"]).out, /=== note \{#other\}\no\n===/);
});

test("set --in with a missing source file exits 1, writes nothing", () => {
  const before = "=== note {#a}\nbody\n===\n";
  const tf = write("frag-noio.geml", before);
  const r = run(["set", tf, "#a", "--in", `${p("ghost.geml")}#a`, "-o", tf]);
  assert.equal(r.code, 1);
  assert.match(r.err, /cannot read/);
  assert.equal(read(tf), before, "target unchanged after failure");
});

test("set --head --in FILE#id keeps the fragment to its head line too (--head stays consistent)", () => {
  // --head narrows the TARGET to its head line; the fragment must narrow the
  // same way, so `set --head --in F#id` is a head-to-head swap, not a full
  // block spilled into a head slot.
  const tf = write("frag-head-target.geml", "# Intro {#intro}\n\nbody stays here.\n\n# Tail {#tail}\ntail body\n");
  write("frag-head-src.geml", "# Welcome {#intro}\nsource body must NOT leak\n");
  const r = run(["set", tf, "#intro", "--head", "--in", `${p("frag-head-src.geml")}#intro`, "-o", tf]);
  assert.equal(r.code, 0, r.err);
  assert.match(run(["get", tf, "#intro", "--head"]).out, /# Welcome \{#intro\}/, "head line swapped");
  const section = run(["get", tf, "#intro"]).out;
  assert.match(section, /body stays here\./, "target body preserved");
  assert.doesNotMatch(section, /source body must NOT leak/, "the fragment stayed at its head line — no body leak");
});

test("set --in FILE# (empty id) exits 1 and writes nothing", () => {
  const before = "=== note {#a}\nbody\n===\n";
  const tf = write("frag-emptyid.geml", before);
  write("frag-emptyid-src.geml", "=== note {#x}\nx\n===\n");
  const r = run(["set", tf, "#a", "--in", `${p("frag-emptyid-src.geml")}#`, "-o", tf]);
  assert.equal(r.code, 1);
  assert.equal(read(tf), before, "target unchanged");
});

test("set --in #id (empty source file) exits 1 and writes nothing", () => {
  const before = "=== note {#a}\nbody\n===\n";
  const tf = write("frag-emptyfile.geml", before);
  const r = run(["set", tf, "#a", "--in", "#a", "-o", tf]);
  assert.equal(r.code, 1);
  assert.match(r.err, /cannot read/);
  assert.equal(read(tf), before, "target unchanged");
});

// -- the content model: two input channels x three modes --------------------
// (--in F[#src] = extract a BLOCK from GEML file F; stdin = raw bytes.
//  default = whole block, --head = head line, --body = body. Default/--head
//  normalize the content id to the target; --body keeps the head verbatim.)

test("example: --in F (no #src) extracts the block whose id == the target, normalizes, replaces whole", () => {
  const doc = write("ex1-doc.geml", "# H {#h}\n\n=== note {#t}\nold body\n===\n\ntail\n");
  write("ex1-draft.geml", "junk prose\n\n=== note {#t .lead}\nDRAFT BODY\n===\n\nmore junk\n");
  const r = run(["set", doc, "#t", "--in", p("ex1-draft.geml"), "-o", "-"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /=== note \{#t .lead\}\nDRAFT BODY\n===/);
  assert.match(r.out, /# H \{#h\}/); // neighbours intact — only #t's span changed
});

test("example: --in F errors when F has no block with the target id", () => {
  const doc = write("ex1b-doc.geml", "=== note {#t}\nbody\n===\n");
  write("ex1b-draft.geml", "=== note {#other}\nx\n===\n");
  const r = run(["set", doc, "#t", "--in", p("ex1b-draft.geml"), "-o", doc]);
  assert.equal(r.code, 1);
  assert.match(r.err, /no block with id `t`/);
});

test("example: --in F#src extracts #src, normalizes its id to the target, replaces whole", () => {
  const doc = write("ex2-doc.geml", "=== note {#t}\nold\n===\n");
  write("ex2-draft.geml", "=== note {#src .x}\nFROM SRC\n===\n");
  const r = run(["set", doc, "#t", "--in", `${p("ex2-draft.geml")}#src`, "-o", "-"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /=== note \{#t .x\}\nFROM SRC\n===/);
  assert.doesNotMatch(r.out, /#src/);
});

test("example: stdin default mode — a block is normalized to the target id and replaces whole", () => {
  const doc = write("ex3-doc.geml", "=== note {#t}\nold\n===\n");
  const r = run(["set", doc, "#t", "-o", "-"], "=== note {#x}\nPIPED\n===\n");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /=== note \{#t\}\nPIPED\n===/);
});

test("example: default mode rejects pure prose and points at --body", () => {
  const doc = write("ex4-doc.geml", "=== text {#t}\nold\n===\n");
  const r = run(["set", doc, "#t"], "just prose\n");
  assert.equal(r.code, 1);
  assert.match(r.err, /--body/);
});

test("example: --body replaces only the body from stdin, keeping the head (and #t)", () => {
  const doc = write("ex5-doc.geml", "=== text {#t .lead}\nold body\n===\n");
  const r = run(["set", doc, "#t", "--body", "-o", "-"], "brand new body\n");
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "=== text {#t .lead}\nbrand new body\n===\n");
});

test("example: --body --in F takes the target block's BODY from F", () => {
  const doc = write("ex6-doc.geml", "=== text {#t}\nold\n===\n");
  write("ex6-draft.geml", "=== text {#t}\nbody line one\nbody line two\n===\n");
  const r = run(["set", doc, "#t", "--body", "--in", p("ex6-draft.geml"), "-o", "-"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "=== text {#t}\nbody line one\nbody line two\n===\n");
});

test("example: --body --in F#src takes #src's BODY", () => {
  const doc = write("ex7-doc.geml", "=== text {#t}\nold\n===\n");
  write("ex7-draft.geml", "=== text {#src}\nsourced body\n===\n");
  const r = run(["set", doc, "#t", "--body", "--in", `${p("ex7-draft.geml")}#src`, "-o", "-"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "=== text {#t}\nsourced body\n===\n");
});

test("example: --head --in F#src takes #src's HEAD line, normalized to the target", () => {
  const doc = write("ex8-doc.geml", "=== table {#t}\n| a |\n|---|\n| 1 |\n===\n");
  write("ex8-draft.geml", "=== table {#src caption=\"Q\"}\n| z |\n|---|\n| 9 |\n===\n");
  const r = run(["set", doc, "#t", "--head", "--in", `${p("ex8-draft.geml")}#src`, "-o", "-"]);
  assert.equal(r.code, 0, r.err);
  // head normalized to #t (with the source's caption); the target's body stays.
  assert.equal(r.out, "=== table {#t caption=\"Q\"}\n| a |\n|---|\n| 1 |\n===\n");
});

// -- channel/mode edges ------------------------------------------------------

test("--in - reads the replacement from stdin (raw channel), same as omitting --in", () => {
  const doc = write("exin-doc.geml", "=== note {#t}\nold\n===\n");
  const r = run(["set", doc, "#t", "--in", "-", "-o", "-"], "=== note {#z}\nvia dash\n===\n");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /=== note \{#t\}\nvia dash\n===/);
});

test("--head and --body together is a usage error (exit 2)", () => {
  const doc = write("exhb-doc.geml", "=== note {#t}\nx\n===\n");
  const r = run(["set", doc, "#t", "--head", "--body"], "y\n");
  assert.equal(r.code, 2);
  assert.match(r.err, /--head.*--body|mutually exclusive/);
});

test("--body with empty stdin is the unified 'no replacement content' error", () => {
  const doc = write("exeb-doc.geml", "=== text {#t}\nx\n===\n");
  const r = run(["set", doc, "#t", "--body"], "");
  assert.equal(r.code, 1);
  assert.match(r.err, /no replacement content/);
});

test("both document and content from stdin is a usage error", () => {
  const r = run(["set", "-", "#t", "--in", "-"], "=== note {#t}\nx\n===\n");
  assert.equal(r.code, 2);
  assert.match(r.err, /stdin/);
});

test("--body on a heading section replaces everything under the heading line", () => {
  const f = write("exbh.geml", "# Title {#t}\n\nold prose\n\nmore old\n");
  const r = run(["set", f, "#t", "--body", "-o", "-"], "fresh prose\n");
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "# Title {#t}\nfresh prose\n");
});

// -- heading-line selectors --------------------------------------------------
// A heading can be addressed by the LINE as it reads in the document, not only
// by its auto-slug: `## API 设计 (v1)` instead of `#api-设计-v1`. An id never
// contains whitespace, so a `#` run followed by a space is unambiguously the
// heading-line form and cannot collide with an id.

test("a heading LINE addresses the same section as its auto-slug id", () => {
  const f = write("hsel.geml", "# API 设计 (v1)\n\nbody one\n\n## Sub\n\nbody two\n");
  const bySlug = run(["get", f, "#api-设计-v1"]);
  const byLine = run(["get", f, "# API 设计 (v1)"]);
  assert.equal(bySlug.code, 0, bySlug.err);
  assert.equal(byLine.code, 0, byLine.err);
  assert.equal(byLine.out, bySlug.out, "both spellings return the same bytes");
  assert.match(byLine.out, /body one/);
  assert.match(byLine.out, /body two/, "a heading addresses its whole section");
});

test("the `#` count is a disambiguator, not a filter: a unique text resolves at any level", () => {
  const f = write("hlvl.geml", "### Deep Only\n\nx\n");
  const right = run(["get", f, "### Deep Only"]);
  const wrong = run(["get", f, "# Deep Only"]); // remembered at the wrong level
  assert.equal(right.code, 0, right.err);
  assert.equal(wrong.code, 0, wrong.err);
  assert.equal(wrong.out, right.out);
});

test("when two headings share a text, the level picks one; otherwise the candidates are listed", () => {
  const f = write("hamb.geml", "# Notes\n\na\n\n## Notes {#notes-2}\n\nb\n");
  const byLevel = run(["get", f, "## Notes"]);
  assert.equal(byLevel.code, 0, byLevel.err);
  assert.match(byLevel.out, /\{#notes-2\}/, "the h2 was selected by its level");
  const ambiguous = run(["get", f, "### Notes"]); // matches neither level
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.err, /matches 2 headings/);
  assert.match(ambiguous.err, /#notes\b/);
  assert.match(ambiguous.err, /#notes-2/);
});

test("a heading line that matches nothing points at the discovery command", () => {
  const f = write("hmiss.geml", "# Real\n\nx\n");
  const r = run(["get", f, "## Not A Heading Here"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /no id or heading matches/);
  assert.match(r.err, /list every addressable/);
});

test("the space after the `#` run is optional, and the heading text needs no slugging", () => {
  const f = write("hnospace.geml", "## API 设计 (v1)\n\nbody\n");
  const slug = run(["get", f, "#api-设计-v1"]);          // the canonical id
  const spaced = run(["get", f, "## API 设计 (v1)"]);     // the line as written
  const tight = run(["get", f, "##API 设计 (v1)"]);       // no space after ##
  assert.equal(slug.code, 0, slug.err);
  assert.equal(spaced.code, 0, spaced.err);
  assert.equal(tight.code, 0, tight.err);
  assert.equal(spaced.out, slug.out);
  assert.equal(tight.out, slug.out);
});

test("a pasted id WINS over a heading whose text happens to read the same", () => {
  // `#Tips` is a note's id; the heading's text is also "Tips" (auto-slug #tips).
  // An id copied out of a reference must never be reinterpreted as prose.
  const f = write("hwins.geml", "=== note {#Tips}\nfrom the note\n===\n\n## Tips\n\nfrom the section\n");
  const byId = run(["get", f, "#Tips"]);
  assert.equal(byId.code, 0, byId.err);
  assert.match(byId.out, /from the note/);
  assert.doesNotMatch(byId.out, /from the section/);
  const byLine = run(["get", f, "## Tips"]);
  assert.equal(byLine.code, 0, byLine.err);
  assert.match(byLine.out, /from the section/, "the heading line still addresses the heading");
});

test("heading-line selectors compose with --head and --json", () => {
  const f = write("hcompose.geml", "## Title Here\n\nbody\n");
  const head = run(["get", f, "## Title Here", "--head"]);
  assert.equal(head.code, 0, head.err);
  assert.match(head.out, /^## Title Here/);
  assert.doesNotMatch(head.out, /body/, "--head narrows to the heading line");
  const json = run(["get", f, "## Title Here", "--json"]);
  assert.equal(json.code, 0, json.err);
  const env = JSON.parse(json.out);
  assert.equal(env.kind, "section");
  assert.equal(env.id, "title-here");
});

test("an id containing no space is still read as an id, never as heading text", () => {
  const f = write("hid.geml", "=== note {#plain}\nn\n===\n");
  const hashed = run(["get", f, "#plain"]);
  const bare = run(["get", f, "plain"]);
  assert.equal(hashed.code, 0, hashed.err);
  assert.equal(bare.code, 0, bare.err);
  assert.match(hashed.out, /=== note \{#plain\}/);
  assert.equal(bare.out, hashed.out);
});

// -- fence-line (type) selectors ---------------------------------------------
// Ids are OPTIONAL in GEML, so meta / a callout note / a table often has none.
// The fence line is then the selector: it resolves whenever the type identifies
// one block, and lists the candidates when it doesn't. No type is special-cased.

test("a fence line addresses an id-less block by type", () => {
  const f = write("tsel.geml", '=== meta\ntitle = "Demo"\n===\n\n# H\n\nbody\n');
  const r = run(["get", f, "=== meta"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '=== meta\ntitle = "Demo"\n===\n', "the block's exact bytes");
  const tight = run(["get", f, "===meta"]); // the space is optional here too
  assert.equal(tight.out, r.out);
});

test("several blocks of a type return N CONTENTS on stdout, the count on stderr", () => {
  // §5 / §9 change 1: this used to print a coordinate list to stdout. A type
  // filter is a pattern match, so N matches are N answers — and stdout carries
  // document bytes only, with no synthesized separator, so a redirect stays usable.
  const f = write("tmulti.geml", "=== note\nfirst\n===\n\n=== note {#second}\nsecond\n===\n");
  const r = run(["get", f, "=== note"]);
  assert.equal(r.code, 0, "N matches is an answer, not a failure");
  assert.equal(r.out, "=== note\nfirst\n===\n=== note {#second}\nsecond\n===\n",
    "both blocks' exact bytes, in document order, concatenated");
  assert.match(r.err, /2 `note` blocks/);
  assert.match(r.err, /L1-3/, "where they are goes to stderr");
  assert.match(r.err, /L5-7 #second/, "an id is shown when there is one");
});

test("a fence line that declares an id defers to the id path", () => {
  const f = write("tid.geml", "=== note\nplain\n===\n\n=== note {#named}\nnamed one\n===\n");
  const r = run(["get", f, "=== note {#named}"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /named one/);
  assert.doesNotMatch(r.out, /plain/);
});

test("a type with no block in the document points at the discovery command", () => {
  const f = write("tnone.geml", "# H\n\nbody\n");
  const r = run(["get", f, "=== table"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /no `table` block/);
  assert.match(r.err, /list every addressable/);
});

test("--json on a unique type gives the parsed node; on several, the N nodes", () => {
  const one = write("tj1.geml", '=== meta\ntitle = "T"\nn = 2\n===\n');
  const r1 = run(["get", one, "=== meta", "--json"]);
  assert.equal(r1.code, 0, r1.err);
  const node = JSON.parse(r1.out);
  assert.equal(node.kind, "block");
  assert.equal(node.type, "meta");
  assert.deepEqual(node.data, { title: "T", n: 2 }, "meta answers with its key/values");

  // §9 change 2: the old `{kind:"blocks", matches:[{lines}]}` coordinate
  // envelope answered "where are they" when the question is "what are they".
  const many = write("tj2.geml", "=== note\na\n===\n\n=== note\nb\n===\n");
  const r2 = run(["get", many, "=== note", "--json"]);
  assert.equal(r2.code, 0, r2.err);
  const nodes = JSON.parse(r2.out);
  assert.ok(Array.isArray(nodes), "N matches yield an array of model nodes");
  assert.equal(nodes.length, 2);
  assert.deepEqual(nodes.map((n) => n.kind), ["block", "block"]);
  assert.deepEqual(nodes.map((n) => n.type), ["note", "note"]);
});

test("--head on a fence selector narrows to the opening fence", () => {
  const f = write("thead.geml", "=== note {#k .warn}\nbody line\n===\n");
  const r = run(["get", f, "=== note", "--head"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^=== note \{#k \.warn\}/);
  assert.doesNotMatch(r.out, /body line/);
});

// --- position selectors, `list` and `find` -------------------------------
// The discovery half of the workflow. Every assertion here is really the same
// one: what a tool PRINTS must paste back in as an address, so a line number
// coming from grep, an editor or a stack trace never has to stay a line number.

// Spans nest — a heading's span is its whole section — so every line in this
// document sits inside `#sec` as well as inside the block it belongs to.
const NEST =
  "# Doc {#top}\n\n" +
  "## Section {#sec}\n\n" +
  "prose under the section\n\n" +
  "=== note {#inner}\n" +
  "needle lives here\n" +
  "===\n\n" +
  "trailing prose\n";

test("a position selector resolves to the INNERMOST block, not the enclosing section", () => {
  const f = write("pos.geml", NEST);
  // Line 7 is `needle lives here`, inside #inner, inside #sec, inside #top.
  const r = run(["get", f, "L7", "--head"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^=== note \{#inner\}/, "the smallest containing unit wins");
});

test("a position RANGE round-trips the `L27-58` the listing prints", () => {
  const f = write("pos2.geml", NEST);
  const list = run(["list", f]);
  assert.equal(list.code, 0, list.err);
  // Pull #inner's own printed range straight out of the listing and feed it back.
  const row = list.out.split("\n").find((l) => l.startsWith("#inner"));
  const span = (row ?? "").match(/L(\d+)-(\d+)/);
  assert.ok(span, `listing prints a line range for #inner: ${row}`);
  const back = run(["get", f, `L${span[1]}-${span[2]}`, "--head"]);
  assert.equal(back.code, 0, back.err);
  assert.match(back.out, /#inner/, "what the listing prints pastes straight back");
});

test("`#L7` is still an id, so a block actually named L7 stays reachable", () => {
  const f = write("posid.geml", "=== note {#L7}\nnamed L7\n===\n\n=== note {#other}\nsecond\n===\n");
  const r = run(["get", f, "#L7"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /named L7/, "the explicit key form addresses the id, not a position");
});

test("a bad position selector is refused, not clamped", () => {
  const f = write("posbad.geml", NEST);
  for (const sel of ["L0", "L9-2"]) {
    // Neither is a position: both fall through to the id form and find no id.
    assert.notEqual(run(["get", f, sel]).code, 0, `${sel} must not silently mean something else`);
  }
  const past = run(["get", f, "L9999"]);
  assert.equal(past.code, 1);
  assert.match(past.err, /no block contains L9999/);
});

test("`list` prints what `get` with no selector prints", () => {
  const f = write("lst.geml", NEST);
  assert.equal(run(["list", f]).out, run(["get", f]).out, "one operation, one output, two names");
});

test("`list` refuses a selector and names the command that takes one", () => {
  const f = write("lst2.geml", NEST);
  const r = run(["list", f, "#inner"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /takes no selector/);
  assert.match(r.err, /geml get/, "points at the verb that does take one");
});

test("`find` reports the innermost block once, and the hit pastes into `get`", () => {
  const f = write("fnd.geml", NEST);
  const r = run(["find", "needle", f]);
  assert.equal(r.code, 0, r.err);
  const rows = r.out.trim().split("\n");
  assert.equal(rows.length, 1, `one block holds the needle, so one row: ${r.out}`);
  const [file, address] = rows[0].split("\t");
  assert.equal(address, "#inner", "the address is the block, not its enclosing section");
  // The contract: column 1 and column 2 are exactly `geml get <file> <address>`.
  const back = run(["get", file, address, "--head"]);
  assert.equal(back.code, 0, back.err);
  assert.match(back.out, /#inner/);
});

test("`find` collapses many matching lines in one block to one row", () => {
  const f = write("fnd2.geml", "=== note {#many}\nneedle\nneedle\nneedle\n===\n");
  const r = run(["find", "needle", f]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim().split("\n").length, 1, "a block is reported once, however often it matched");
});

test("`find` is case-insensitive by default and exact under --case", () => {
  const f = write("fnd3.geml", "=== note {#c}\nNeedle\n===\n");
  assert.equal(run(["find", "needle", f]).code, 0, "default folds case");
  assert.equal(run(["find", "needle", f, "--case"]).code, 1, "--case does not");
});

test("`find` exits 1 on no match so a shell `if` works, and --json still prints []", () => {
  const f = write("fnd4.geml", NEST);
  const r = run(["find", "definitely-absent-xyz", f]);
  assert.equal(r.code, 1);
  assert.equal(r.out.trim(), "");
  const j = run(["find", "definitely-absent-xyz", f, "--json"]);
  assert.equal(j.code, 1, "the exit code still reports no match");
  assert.deepEqual(JSON.parse(j.out), [], "a JSON consumer sees an empty array, not empty output");
});

test("`find` walks a directory for *.geml and skips node_modules", () => {
  const sub = join(dir, "walk");
  mkdirSync(join(sub, "node_modules"), { recursive: true });
  writeFileSync(join(sub, "a.geml"), "=== note {#wa}\nfindme\n===\n");
  writeFileSync(join(sub, "skip.md"), "findme\n");
  writeFileSync(join(sub, "node_modules", "v.geml"), "=== note {#vendored}\nfindme\n===\n");
  const r = run(["find", "findme", sub]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /#wa/);
  assert.doesNotMatch(r.out, /vendored/, "a vendored copy is not an answer");
  assert.doesNotMatch(r.out, /skip\.md/, "only .geml is searched");
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} test(s) passed.`);

test("the listing gives EVERY row a line range — a section's most of all", () => {
  // The range used to be the alternative to a heading's text, so a section —
  // the one span you most often want to address whole — was the one row that
  // never printed one. And `L11-493` is itself an address: what the listing
  // prints has to paste back into `get`.
  const dir = mkdtempSync(join(tmpdir(), "geml-listlines-"));
  const f = join(dir, "d.geml");
  writeFileSync(f, "# Top {#top}\n\nprose\n\n=== note {#n}\nhi\n===\n\n## Sub {#sub}\n\nmore\n");
  const out = run(["list", f]).out.trim().split("\n");
  for (const line of out) {
    assert.match(line, /\bL\d+-\d+\b/, `every row carries a range: ${line}`);
  }
  const heading = out.find((l) => l.includes("#top"));
  assert.match(heading, /L\d+-\d+\s+Top$/, "the heading keeps its text AFTER the range");

  // Paste a printed range straight back.
  const span = /L(\d+)-(\d+)/.exec(out.find((l) => l.includes("#n")))[0];
  assert.match(run(["get", f, span]).out, /=== note \{#n\}/, `${span} addresses the block it was printed for`);
  rmSync(dir, { recursive: true, force: true });
});

// --- `--intro`: what a heading says before its first subheading
//
// The region a section most needs and had no address for: `#id` is the whole
// subtree, `--head` is one line, `--body` is everything under it, and a
// position selector snaps outward to the enclosing section. Bounded by the next
// heading of ANY level, since a deeper one opens a subsection and a
// same-or-higher one ends the section — the same line either way.

const INTRO_DOC = "=== meta\ntitle = \"t\"\n===\n\n# Top {#top}\n\nlead prose\n\n"
  + "=== note {#n}\nin the lead\n===\n\n## Sub {#sub}\n\nsub prose\n\n### Deep {#deep}\n\ndeep prose\n";

function introFile(body = INTRO_DOC) {
  const dir = mkdtempSync(join(tmpdir(), "geml-intro-"));
  const f = join(dir, "d.geml");
  writeFileSync(f, body);
  return f;
}

test("--intro stops at the first subheading, whatever its level", () => {
  const f = introFile();
  const out = run(["get", f, "#top", "--intro"]).out;
  assert.match(out, /lead prose/);
  assert.match(out, /=== note \{#n\}/, "blocks inside the opening region come along");
  assert.doesNotMatch(out, /Sub|sub prose|Deep/, "the subsections do not");
});

test("--intro on a heading with no subheading is its whole body", () => {
  const f = introFile();
  assert.equal(run(["get", f, "#deep", "--intro"]).out, run(["get", f, "#deep", "--body"]).out);
});

test("--intro is empty when a subheading follows immediately", () => {
  const f = introFile("=== meta\ntitle = \"t\"\n===\n\n# A {#a}\n## B {#b}\n\nx\n");
  const r = run(["get", f, "#a", "--intro"]);
  assert.equal(r.out, "", "an empty region is an empty answer, not the body");
  assert.equal(r.code, 0);
});

test("--intro refuses a block: only a heading has subheadings", () => {
  const f = introFile();
  const r = run(["get", f, "#n", "--intro"]);
  assert.equal(r.code, 2, "a usage error, not a silent fallback to --body");
  assert.match(r.err, /--intro names a heading's opening region/);
});

test("a replacement that removes blocks is done and reported, named or not", () => {
  // One rule for destructive edits, the one `delete` already set: do it, and say
  // what it cost. Refusing had made the region unreachable — a section whose
  // opening held a named note could not have that opening replaced at all —
  // while the same note without an id went in silence. A block's fate must not
  // turn on whether anyone named it.
  const named = introFile();
  const rn = run(["set", named, "#top", "--intro", "-o", named], "NEW lead\n");
  assert.equal(rn.code, 0, rn.err);
  assert.match(rn.err, /dropped `#n`/);
  assert.match(rn.err, /geml revert/, "and the way back is in the message");
  assert.doesNotMatch(readFileSync(named, "utf8"), /note body/);

  const anon = introFile("=== meta\ntitle = \"t\"\n===\n\n# Top {#top}\n\nlead\n\n=== note\nunnamed\n===\n\n## Sub {#sub}\n\ns\n");
  const ra = run(["set", anon, "#top", "--intro", "-o", anon], "NEW lead\n");
  assert.equal(ra.code, 0, ra.err);
  assert.match(ra.err, /dropped 1 unnamed block/, "an unnamed block is reported too, not dropped in silence");
});

test("a reference the removal orphans is a warning; one the new content invents is refused", () => {
  // The difference is whether the missing target is a block THIS splice took
  // away. Being told a consequence is not the same as writing something broken.
  const orphan = introFile("=== meta\ntitle = \"t\"\n===\n\n# Top {#top}\n\nlead\n\n=== note {#n}\nx\n===\n\n## Sub {#sub}\n\nsee [[#n]]\n");
  const ro = run(["set", orphan, "#top", "--intro", "-o", orphan], "NEW lead\n");
  assert.equal(ro.code, 0, "the caller asked for the removal; they are told, not blocked");
  assert.match(ro.err, /left dangling by the replacement/);
  assert.equal(run(["check", orphan]).code, 1, "and check reports it as the error it is");

  const invented = introFile();
  const ri = run(["set", invented, "#deep", "--intro", "-o", invented], "see [[#nope]]\n");
  assert.equal(ri.code, 1, "a reference the content invents is a broken write");
  assert.match(ri.err, /would break the document/);
  assert.match(readFileSync(invented, "utf8"), /deep prose/, "nothing was written");
});

test("the ordinary read-edit-write cycle drops nothing and says nothing", () => {
  const f = introFile();
  const got = run(["get", f, "#top", "--intro"]).out.replace("lead prose", "EDITED");
  const r = run(["set", f, "#top", "--intro", "--in", "-", "-o", f], got);
  assert.equal(r.code, 0);
  assert.equal(r.err.replace(/^wrote .*$/m, "").trim(), "", "no report, because nothing was lost");
  const after = readFileSync(f, "utf8");
  assert.match(after, /EDITED/);
  assert.match(after, /=== note \{#n\}/, "the block came back because it was handed over and sent back");
});

test("set --intro replaces the opening and leaves every subsection byte-identical", () => {
  // The invariant that makes the flag safe: what `get --intro` hands out is what
  // `set --intro` puts back, so a read-edit-write cycle cannot swallow a subtree.
  const f = introFile("=== meta\ntitle = \"t\"\n===\n\n# Top {#top}\n\nlead prose\n\n## Sub {#sub}\n\nsub prose\n\n### Deep {#deep}\n\ndeep prose\n");
  const before = readFileSync(f, "utf8");
  const tail = before.slice(before.indexOf("## Sub"));
  const r = run(["set", f, "#top", "--intro", "-o", f], "NEW lead\n");
  assert.equal(r.code, 0, r.err);
  const after = readFileSync(f, "utf8");
  assert.match(after, /NEW lead/);
  assert.doesNotMatch(after, /lead prose/);
  assert.equal(after.slice(after.indexOf("## Sub")), tail, "everything from the first subheading down is untouched");
  assert.equal(run(["check", f]).code, 0, "and the document is still valid");
});

test("set --intro on an empty region writes an opening where there was none", () => {
  const f = introFile("=== meta\ntitle = \"t\"\n===\n\n# A {#a}\n## B {#b}\n\nx\n");
  assert.equal(run(["set", f, "#a", "--intro", "-o", f], "written in\n").code, 0);
  const after = readFileSync(f, "utf8");
  // Separated from both neighbours — an opening written into an empty region
  // still must not fuse the two headings around it.
  assert.match(after, /# A \{#a\}\r?\n\r?\nwritten in\r?\n\r?\n## B \{#b\}/);
  assert.equal(run(["check", f]).code, 0);
});

test("the three part flags are mutually exclusive on both get and set", () => {
  const f = introFile();
  for (const verb of ["get", "set"]) {
    const r = run([verb, f, "#top", "--body", "--intro"]);
    assert.equal(r.code, 2, `${verb} must refuse two part flags`);
    assert.match(r.err, /mutually exclusive/);
  }
});

test("set --intro gives the opening its blank lines back, without disturbing a round trip", () => {
  // Two demands at once: content typed by hand must not fuse the heading, the
  // text and the next subheading onto consecutive lines, and text that came
  // from `get --intro` — which already carries those blank lines — must land
  // byte-identical. So the separator is added only on a side that lacks one.
  const typed = introFile("=== meta\ntitle = \"t\"\n===\n\n# Top {#top}\n\nold\n\n## Sub {#sub}\n\ns\n");
  assert.equal(run(["set", typed, "#top", "--intro", "-o", typed], "typed in\n").code, 0);
  assert.match(readFileSync(typed, "utf8"), /# Top \{#top\}\r?\n\r?\ntyped in\r?\n\r?\n## Sub/);

  const trip = introFile();
  const before = readFileSync(trip, "utf8");
  const got = run(["get", trip, "#top", "--intro"]).out;
  assert.equal(run(["set", trip, "#top", "--intro", "--in", "-", "-o", trip], got).code, 0);
  assert.equal(readFileSync(trip, "utf8"), before, "handing the region straight back changes nothing");
});


test("set does not stamp an id a heading already derives (Markdown stays Markdown)", () => {
  // `## Alpha` derives `#alpha`, so writing that heading back needs no
  // attribute object. Stamping one would be invisible in GEML but render as
  // literal `{#alpha}` on GitHub — and these verbs address plain .md too.
  const d = mkdtempSync(join(tmpdir(), "geml-nostamp-"));
  const f = join(d, "derived.md");
  writeFileSync(f, "# Doc\n\n## Alpha\n\nfirst.\n\n## Beta\n\nsecond.\n");
  assert.equal(run(["set", f, "#alpha", "--in", "-", "-o", f], "## Alpha\n\nreplaced.\n").code, 0);
  const after = readFileSync(f, "utf8");
  assert.match(after, /^## Alpha\r?$/m, "heading line untouched");
  assert.doesNotMatch(after, /\{#/, "no attribute object anywhere");
  assert.match(after, /replaced\./);
  assert.equal(run(["get", f, "#alpha"]).code, 0, "still addressable by the same id");
  rmSync(d, { recursive: true, force: true });
});

test("set still stamps the id when the content would not otherwise carry it", () => {
  // The skip above is ONLY for content that already resolves to the target id.
  // A renamed heading, a foreign id, and a typed block without one all still
  // get normalized — dropping that would silently move the block's address.
  const d = mkdtempSync(join(tmpdir(), "geml-stamp-"));
  const at = (n, s) => { const f = join(d, n); writeFileSync(f, s); return f; };

  const renamed = at("renamed.md", "# Doc\n\n## Alpha\n\nfirst.\n");
  run(["set", renamed, "#alpha", "--in", "-", "-o", renamed], "## Renamed\n\nbody.\n");
  assert.match(readFileSync(renamed, "utf8"), /## Renamed \{#alpha\}/, "a renamed heading keeps the address");

  const foreign = at("foreign.md", "# Doc\n\n## Alpha\n\nfirst.\n");
  run(["set", foreign, "#alpha", "--in", "-", "-o", foreign], "## Alpha {#other}\n\nbody.\n");
  assert.match(readFileSync(foreign, "utf8"), /## Alpha \{#alpha\}/, "a foreign id is normalized, not kept");

  const fenced = at("fenced.geml", "=== meta\ntitle = \"t\"\n===\n\n=== code {#hello lang=py}\nx=1\n===\n");
  run(["set", fenced, "#hello", "--in", "-", "-o", fenced], "=== code {lang=py}\ny=2\n===\n");
  assert.match(readFileSync(fenced, "utf8"), /=== code \{#hello lang=py\}/, "a typed block with no id still gains it");
  rmSync(d, { recursive: true, force: true });
});

test("a defect the document already had does not block an unrelated edit", () => {
  // `[…](#short)` aims at an `<a id>` GEML does not model: an unresolved
  // reference here, ordinary Markdown on GitHub. It used to make every write to
  // the file fail — the guard is for breakage this edit CAUSES.
  const d = mkdtempSync(join(tmpdir(), "geml-preexisting-"));
  const f = join(d, "anchored.md");
  const src = '# Doc\n\nSee [the guide](#short).\n\n<a id="short"></a>\n## A Long Heading Title\n\nbody here.\n';
  writeFileSync(f, src);
  assert.match(run(["check", f]).err + run(["check", f]).out, /unresolved reference/, "the defect is real and reported");

  assert.equal(run(["set", f, "#a-long-heading-title", "--body", "--in", "-", "-o", f], "new body.\n").code, 0);
  assert.match(readFileSync(f, "utf8"), /new body\./, "the unrelated edit lands");
  assert.match(run(["check", f]).err + run(["check", f]).out, /unresolved reference/, "and the old defect is still reported, not swallowed");

  writeFileSync(f, src);
  assert.equal(run(["replace", f, "body here.", "swapped."]).code, 0, "replace is freed by the same rule");
  rmSync(d, { recursive: true, force: true });
});

test("breakage the edit itself introduces is still refused, counted not just matched", () => {
  const d = mkdtempSync(join(tmpdir(), "geml-newbreak-"));
  const f = join(d, "doc.md");

  // Nothing wrong before: a new dangling reference is refused outright.
  writeFileSync(f, "# Doc\n\n## Sec\n\nbody.\n");
  const fresh = run(["set", f, "#sec", "--body", "--in", "-", "-o", f], "see [x](#nope).\n");
  assert.equal(fresh.code, 1);
  assert.match(fresh.err, /would break the document/);
  assert.match(readFileSync(f, "utf8"), /^body\.$/m, "nothing written");

  // One `#dup` already dangling; adding a SECOND is new breakage, and text
  // matching alone would let it through under cover of the first.
  writeFileSync(f, "# Doc\n\n[a](#dup)\n\n## Sec\n\nbody.\n");
  const second = run(["set", f, "#sec", "--body", "--in", "-", "-o", f], "body.\n\n[b](#dup)\n");
  assert.equal(second.code, 1, "a second occurrence of the same message is still new breakage");
  assert.doesNotMatch(readFileSync(f, "utf8"), /\[b\]/, "nothing written");
  rmSync(d, { recursive: true, force: true });
});

test("forgiving a pre-existing defect is scoped to Markdown; a .geml document stays strict", () => {
  // The same defect, the same edit, two file types. Inside GEML "every
  // reference resolves" is the contract its author opted into, so the document
  // is locked until repaired — the MCP server builds on that, telling the model
  // the errors predate its edit. A .md file carries no such contract.
  const d = mkdtempSync(join(tmpdir(), "geml-scope-"));
  const body = "=== note {#x}\nbroken: [[#missing]]\n===\n\n=== note {#y}\nfixable\n===\n";

  const geml = join(d, "doc.geml");
  writeFileSync(geml, body);
  const strict = run(["set", geml, "#y", "--body", "--in", "-", "-o", geml], "edited anyway\n");
  assert.equal(strict.code, 1, "a .geml document is still locked by its own pre-existing break");
  assert.match(strict.err, /unresolved reference/);
  assert.match(readFileSync(geml, "utf8"), /fixable/, "nothing written");

  const md = join(d, "doc.md");
  writeFileSync(md, body);
  assert.equal(run(["set", md, "#y", "--body", "--in", "-", "-o", md], "edited anyway\n").code, 0,
    "the same file named .md is judged only on what the edit breaks");
  assert.match(readFileSync(md, "utf8"), /edited anyway/);
  rmSync(d, { recursive: true, force: true });
});
