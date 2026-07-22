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
  const r = run(["get", f, "#geml-setup"]);   // the id the parser registers
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "# {{title}} Setup\n\nprose\n");
  assert.equal(run(["get", f, "#title-setup"]).code, 1); // the raw-text phantom must not exist
});

test("a CR-only (lone \\r) file: spans and bytes align for get and set", () => {
  const f = write("sec25.geml", "# A {#a}\rpara\r# B {#b}\rx\r");
  assert.equal(run(["get", f, "#a"]).out, "# A {#a}\rpara\r");
  assert.equal(run(["get", f, "#b"]).out, "# B {#b}\rx\r");
  const r = run(["set", f, "#b"], "# B {#b}\nnew x\n");
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

test("get returns a CRLF section byte-exact; set keeps the remainder's CRLF bytes", () => {
  const f = write("sec12.geml", "# A {#a}\r\n\r\nA prose\r\n\r\n# B {#b}\r\nb prose\r\n");
  assert.equal(run(["get", f, "#a"]).out, "# A {#a}\r\n\r\nA prose\r\n\r\n");
  const r = run(["set", f, "#a"], "# A {#a}\nnew prose\n\n");
  assert.equal(r.code, 0);
  // The replacement is normalized to LF; every byte outside the span keeps CRLF.
  assert.equal(r.out, "# A {#a}\nnew prose\n\n# B {#b}\r\nb prose\r\n");
});

test("set may SPLIT a section by adding a new same-level heading (all ids survive)", () => {
  const f = write("sec13.geml", SECDOC);
  const repl = "# A {#a}\n\nshort now\n\n=== code {#c}\nx = 1\n===\n\n# A2 {#a2}\n\nsplit off\n\n";
  assert.equal(run(["set", f, "#a", "-o", f], repl).code, 0);
  assert.equal(run(["get", f, "#a"]).out, "# A {#a}\n\nshort now\n\n=== code {#c}\nx = 1\n===\n\n");
  assert.equal(run(["get", f, "#a2"]).out, "# A2 {#a2}\n\nsplit off\n\n");
});

test("duplicate heading slugs: get still addresses the FIRST section (first wins)", () => {
  const f = write("sec14.geml", "# Intro\nfirst body\n\n# Intro\nsecond body\n");
  assert.equal(run(["get", f, "#intro"]).out, "# Intro\nfirst body\n\n");
  assert.equal(JSON.parse(run(["get", f, "#intro", "--json"]).out).blocks[1].text, "first body");
  const r = run(["set", f, "#intro"], "# Intro\npatched\n\n"); // doc itself is broken: refused
  assert.equal(r.code, 1);
  assert.match(r.err, /duplicate id/);
});

test("set that renames the section's heading id is refused", () => {
  const f = write("sec16.geml", SECDOC);
  const r = run(["set", f, "#a"], "# Renamed {#zzz}\n\nintro prose\n\n=== code {#c}\nx = 1\n===\n\ntail\n\n");
  assert.equal(r.code, 1);
  assert.match(r.err, /removes id `a`/);
  assert.equal(read(f), SECDOC);
});

test("a `#`-without-space line is a paragraph, not a heading or boundary", () => {
  const f = write("sec17.geml", "# A {#a}\n#foo not a heading\n#5 reasons\n\n# B {#b}\nx\n");
  assert.equal(run(["get", f, "#a"]).out, "# A {#a}\n#foo not a heading\n#5 reasons\n\n");
});

test("set on the first heading leaves a leading meta block byte-identical", () => {
  const f = write("sec18.geml", "=== meta\ntitle = X\n===\n\n# First {#first}\nbody\n\n# B {#b}\nx\n");
  const r = run(["set", f, "#first"], "# First {#first}\nnew body\n\n");
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
  const r = run(["set", f, "#inner"], "## Inner {#inner}\nrewritten inner\n");
  assert.equal(r.code, 0);
  assert.equal(r.out, "# Top {#top}\n\n=== note {#nb}\npreamble\n## Inner {#inner}\nrewritten inner\n===\n\ntail\n");
});

test("a {hidden} heading is still addressable as a section", () => {
  const f = write("sec21.geml", "# Secret {#sec hidden}\nhidden body\n\n# B {#b}\nx\n");
  assert.equal(run(["get", f, "#sec"]).out, "# Secret {#sec hidden}\nhidden body\n\n");
});

test("set on a section that IS the entire file replaces the whole document", () => {
  const f = write("sec22.geml", "# Only {#only}\n\neverything\n");
  const r = run(["set", f, "#only"], "# Only {#only}\n\nreplaced everything\n");
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
  const f = write("sec15.geml", "# A {#a}\n\nsee[^fn1] and[^fn2]\n\n[^fn1]: first note\n\n=== code {#c}\nx\n===\n\n[^fn2]: second note\n\n# B {#b}\nx\n");
  const raw = run(["get", f, "#a"]).out;
  const rawIds = JSON.parse(run(["-"], raw).out).ids;
  assert.deepEqual(JSON.parse(run(["get", f, "#a", "--json"]).out).blocks.flatMap(idsIn), rawIds);
  assert.deepEqual(rawIds, ["a", "fn1", "c", "fn2"]);
});

// -- --heading: narrow get/set/revert to the heading LINE --------------------

test("get --heading returns the single heading line (the old default)", () => {
  const f = write("hl1.geml", SECDOC);
  const r = run(["get", "--heading", f, "#a"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "# A {#a}\n");
});

test("get --heading --json returns the lone heading node, not a section envelope", () => {
  const f = write("hl2.geml", SECDOC);
  const node = JSON.parse(run(["get", "--heading", "--json", f, "#a"]).out);
  assert.equal(node.kind, "heading");
  assert.equal(node.id, "a");
  assert.equal(node.blocks, undefined);
});

test("set --heading renames the heading; section prose and nested ids stay byte-identical", () => {
  const f = write("hl3.geml", SECDOC);
  const r = run(["set", "--heading", f, "#a", "-o", f], "# A renamed {#a}\n");
  assert.equal(r.code, 0, r.err);
  assert.equal(read(f), "# A renamed {#a}" + SECDOC.slice("# A {#a}".length));
  assert.equal(run(["get", f, "#c"]).out, "=== code {#c}\n# a comment, not a heading\nx = 1\n===\n");
});

test("--heading on a non-heading id fails with a clear message", () => {
  const f = write("hl4.geml", SECDOC);
  const g = run(["get", "--heading", f, "#c"]);
  assert.equal(g.code, 1);
  assert.match(g.err, /`--heading` applies only to a heading id/);
  const s = run(["set", "--heading", f, "#c"], "=== code {#c}\ny\n===\n");
  assert.equal(s.code, 1);
  assert.match(s.err, /`--heading` applies only to a heading id/);
});

test("get --json on a typed-block id is still the single model node", () => {
  const f = write("secj4.geml", SECDOC);
  const node = JSON.parse(run(["get", f, "#c", "--json"]).out);
  assert.equal(node.kind, "block");
  assert.equal(node.id, "c");
});

test("set on a section that drops a nested id is rejected (guard)", () => {
  const f = write("sec7.geml", SECDOC);
  const r = run(["set", f, "#a", "-o", f], "# A {#a}\n\nprose only, code gone\n");
  assert.equal(r.code, 1);
  assert.match(r.err, /#c/);
  assert.equal(read(f), SECDOC); // nothing written
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
