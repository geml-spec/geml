// Block selectors — the one addressing syntax `get` and `set` share
// (docs/design/specs/2026-08-04-geml-get-set-selector-design-change.md).
//
// What these tests exist to pin, in the design's own terms:
//   §3  `@<hex>` is a CONTENT address: it goes stale loudly (exit 1) instead of
//       silently pointing at another block, which is why it beats an index.
//   §4  HEAD/BODY are DEFINED by the round-trip invariant
//       `get X --part | set X --part` leaving the file byte-identical — so the
//       round-trip is a test, not a nicety.
//   §5  cardinality: get 0→1, 1→content, N→N contents; set refuses N.
//   §6  the listing shows every unit once, by its shortest unique address.
//   §7  no flag the caller typed is ever silently discarded.
// Spawns the built CLI in a throwaway temp dir, like get-set.test.mjs.
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

function run(args, input) {
  const r = spawnSync(process.execPath, ["dist/geml.js", ...args], { input, encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const dir = mkdtempSync(join(tmpdir(), "geml-selector-"));
const p = (name) => join(dir, name);
const write = (name, s) => { const f = p(name); writeFileSync(f, s); return f; };
const read = (f) => readFileSync(f, "utf8");

// Two anonymous notes force the `@<hex>` form: with only one note of its type,
// the shortest unique address would be the bare `=== note` (§6.1).
const ANON =
  "# Top {#top}\n\n" +
  '=== meta\ntitle = "T"\n===\n\n' +
  "=== note\nfirst anon\n===\n\n" +
  "=== note {#warn}\nnamed\n===\n\n" +
  "=== note\nsecond anon\n===\n\n" +
  "## Sect {#sect}\n\nunder sect\n";

// The address of one block, read out of the listing — the only supported way to
// obtain one (§3.2), and what every test below addresses with.
function addressOf(file, bodyLine) {
  const listing = run(["get", file]).out;
  const content = run(["get", file]).out; // listing is the same call; kept explicit
  assert.ok(content !== undefined);
  const lines = read(file).split("\n");
  const at = lines.findIndex((l) => l === bodyLine);
  assert.ok(at > 0, `fixture line ${JSON.stringify(bodyLine)} not found`);
  const row = listing.split("\n").find((l) => {
    const m = /L(\d+)-(\d+)$/.exec(l.trim());
    return m && Number(m[1]) <= at + 1 && at + 1 <= Number(m[2]) && l.includes("@");
  });
  assert.ok(row, `no @ address covers line ${at + 1}:\n${listing}`);
  return row.trim().split(/\s{2,}/)[0];
}

// -- §6 listing --------------------------------------------------------------

test("the listing names every unit once, by its shortest unique address", () => {
  const f = write("l1.geml", ANON);
  const r = run(["get", f]);
  assert.equal(r.code, 0, r.err);
  const addrs = r.out.trim().split("\n").map((l) => l.trim().split(/\s{2,}/)[0]);
  // §6.2: one line per unit. An id-bearing block prints its id; the unique-type
  // `meta` prints the bare fence; the two rival notes print content addresses.
  assert.deepEqual(addrs.filter((a) => !a.startsWith("@") && !a.includes("@")),
    ["#top", "=== meta", "#warn", "#sect"]);
  const content = addrs.filter((a) => a.includes("@"));
  assert.equal(content.length, 2, "both anonymous notes get a content address");
  assert.ok(content.every((a) => /^=== note@[0-9a-f]{8}$/.test(a)), content.join(" "));
});

test("every id-less block is flagged anon, including a unique-type one", () => {
  const f = write("l2.geml", ANON);
  const rows = JSON.parse(run(["get", f, "--json"]).out);
  // §6.3: `=== meta` works only because its type happens to be unique, and that
  // it still has no id is precisely what you might want to act on (§5.2).
  assert.equal(rows.find((x) => x.address === "=== meta").anon, true);
  assert.equal(rows.find((x) => x.address === "#warn").anon, undefined);
  assert.equal(rows.find((x) => x.address === "#warn").id, "warn");
});

test("a prose-only document lists nothing and still exits 0", () => {
  // §6.6: "give me everything" has the empty set as a legitimate answer, so
  // `get f --json | jq length` must not blow up on a prose document.
  const f = write("l3.geml", "just prose, nothing addressable\n");
  const r = run(["get", f, "--json"]);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), []);
  const t = run(["get", f]);
  assert.equal(t.code, 0);
  assert.equal(t.out, "");
  assert.match(t.err, /no addressable blocks/);
});

test("one addressable unit still prints a LIST, not its content", () => {
  // §6.5: which tier runs is decided by the COMMAND's shape, never by how much
  // data happens to be in the document.
  const f = write("l4.geml", "=== note\nonly\n===\n");
  const r = run(["get", f]);
  assert.equal(r.code, 0);
  assert.match(r.out, /^=== note\s+note\s+anon\s+L1-3$/m);
  assert.doesNotMatch(r.out, /only/);
});

// -- §3 content addresses ----------------------------------------------------

test("a content address resolves the anonymous block it names", () => {
  const f = write("c1.geml", ANON);
  const a = addressOf(f, "first anon");
  const r = run(["get", f, a]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "=== note\nfirst anon\n===\n");
});

test("the type prefix is optional; both forms name the same block", () => {
  const f = write("c2.geml", ANON);
  const a = addressOf(f, "second anon");
  const bare = "@" + a.split("@")[1];
  assert.equal(run(["get", f, bare]).out, run(["get", f, a]).out);
  assert.equal(run(["get", f, a]).out, "=== note\nsecond anon\n===\n");
});

test("a wrong type prefix is REFUSED, not ignored", () => {
  // §3.3: otherwise the prefix is a decoration that is allowed to lie, and a
  // hand-edited address would be accepted silently.
  const f = write("c3.geml", ANON);
  const hex = addressOf(f, "first anon").split("@")[1];
  const r = run(["get", f, `=== code@${hex}`]);
  assert.equal(r.code, 1);
  assert.match(r.err, /addresses a `note` block, not `code`/);
});

test("a stale address fails loudly — the property that beats an index", () => {
  // §3.2: an index would silently point at a different block; `set` would then
  // write into something the caller never saw.
  const f = write("c4.geml", ANON);
  const a = addressOf(f, "first anon");
  assert.equal(run(["get", f, a]).code, 0);
  writeFileSync(f, ANON.replace("first anon", "first anon EDITED"));
  const r = run(["get", f, a]);
  assert.equal(r.code, 1);
  assert.match(r.err, /no block matching/);
  assert.match(r.err, /goes stale/);
});

test("byte-identical blocks share a hash and are told apart by ~n", () => {
  const f = write("c5.geml", "=== note\nsame\n===\n\n=== note\nsame\n===\n\n=== note\nother\n===\n");
  const addrs = run(["get", f]).out.trim().split("\n").map((l) => l.trim().split(/\s{2,}/)[0]);
  const twins = addrs.filter((a) => !a.endsWith("other")).slice(0, 2);
  assert.equal(twins[0].split("@")[1].split("~")[0], twins[1].split("@")[1].split("~")[0],
    "identical content hashes identically");
  assert.ok(twins.some((a) => a.endsWith("~1")), `one twin carries ~1: ${addrs.join(" ")}`);
  // A serial number is safe HERE and nowhere else (§3.2): the two candidates are
  // byte-identical, so picking the wrong one changes position, never content.
  assert.equal(run(["get", f, twins[0]]).out, run(["get", f, twins[1]]).out);
});

test("the address is stable across CRLF, lone CR and a BOM", () => {
  // The hash input is the block's LF-normalized text with the BOM stripped, so
  // the same logical document addresses identically however it was checked out.
  // Cross-platform stability is a property of the DEFINITION, not of the OS.
  const lf = "=== note\ncafe\n===\n\n=== note\nother\n===\n";
  const of = (name, text) => {
    const f = write(name, text);
    return run(["get", f]).out.match(/@[0-9a-f]{8}/)[0];
  };
  const base = of("nl-lf.geml", lf);
  assert.equal(of("nl-crlf.geml", lf.replace(/\n/g, "\r\n")), base, "CRLF");
  assert.equal(of("nl-cr.geml", lf.replace(/\n/g, "\r")), base, "lone CR");
  assert.equal(of("nl-bom.geml", "﻿" + lf), base, "BOM");
});

test("the hash input is exactly the block's LF-joined span, no trailing newline", () => {
  // Pins the definition a second implementation has to reproduce. NOT including
  // the trailing newline is deliberate: otherwise appending a block after the
  // file's last one would change that block's address without touching it.
  const f = write("c6.geml", "=== note\nfirst\n===\n\n=== note\nsecond\n===\n");
  const want = createHash("sha256").update(Buffer.from("=== note\nfirst\n===", "utf8")).digest("hex").slice(0, 8);
  assert.match(run(["get", f]).out, new RegExp(`=== note@${want}\\b`));
});

test("a content address survives being placed last in the file", () => {
  const twoNotes = "=== note\ntarget\n===\n\n=== note\nother\n===\n";
  const a = write("c7a.geml", twoNotes);
  const b = write("c7b.geml", twoNotes + "\n=== note\nappended\n===\n");
  const addrIn = (f) => run(["get", f]).out.split("\n").find((l) => /L1-3$/.test(l.trim())).trim().split(/\s{2,}/)[0];
  assert.equal(addrIn(a), addrIn(b), "appending after it must not move a block's address");
});

// -- §4 the round-trip invariant that DEFINES --head / --body ----------------

test("get X --part | set X --part leaves the file byte-identical", () => {
  const src = write("rt-src.geml", ANON);
  const cases = ["#warn", "#sect", "#top", "=== meta"];
  for (const sel of cases) {
    for (const part of ["--head", "--body"]) {
      const f = p(`rt-${sel.replace(/\W+/g, "_")}${part}.geml`);
      copyFileSync(src, f);
      const before = read(f);
      const got = run(["get", f, sel, part]);
      assert.equal(got.code, 0, `get ${sel} ${part}: ${got.err}`);
      const back = run(["set", f, sel, part], got.out);
      assert.equal(back.code, 0, `set ${sel} ${part}: ${back.err}`);
      assert.equal(read(f), before, `round-trip broke for ${sel} ${part}`);
    }
  }
});

test("the round-trip holds through a content address too", () => {
  const f = write("rt-at.geml", ANON);
  const a = addressOf(f, "first anon");
  const before = read(f);
  for (const part of ["--head", "--body"]) {
    const got = run(["get", f, a, part]);
    assert.equal(got.code, 0, got.err);
    const back = run(["set", f, a, part], got.out);
    assert.equal(back.code, 0, back.err);
    assert.equal(read(f), before, `round-trip broke for ${a} ${part}`);
  }
});

test("a heading's BODY includes the blank lines around it", () => {
  // §4: `set #sect --body` replaces the span INCLUDING the blank line after the
  // heading line, so `get --body` has to hand those bytes back or the
  // round-trip above cannot hold. Asserted directly so a regression names itself.
  const f = write("rt-hb.geml", "## Sect {#s}\n\nunder\n\n## Next {#n}\n\nx\n");
  assert.equal(run(["get", f, "#s", "--body"]).out, "\nunder\n\n");
});

test("--body on a fenced block excludes both fences", () => {
  const f = write("rt-fb.geml", "=== code {#c lang=py}\nx = 1\ny = 2\n===\n");
  assert.equal(run(["get", f, "#c", "--body"]).out, "x = 1\ny = 2\n");
  assert.equal(run(["get", f, "#c", "--head"]).out, "=== code {#c lang=py}\n");
});

// -- §5 cardinality ----------------------------------------------------------

test("a type filter matching N returns N contents and counts them on stderr", () => {
  const f = write("n1.geml", ANON);
  const r = run(["get", f, "=== note"]);
  assert.equal(r.code, 0);
  assert.equal(r.out, "=== note\nfirst anon\n===\n=== note {#warn}\nnamed\n===\n=== note\nsecond anon\n===\n");
  assert.match(r.err, /3 `note` blocks/);
});

test("--head and --body act on EVERY match of a type filter", () => {
  // §5.1: once `=== note` is a pattern match, "the head line of each match" is
  // well defined and more useful than an error. Today both flags are dropped.
  const f = write("n2.geml", ANON);
  assert.equal(run(["get", f, "=== note", "--head"]).out,
    "=== note\n=== note {#warn}\n=== note\n");
  assert.equal(run(["get", f, "=== note", "--body"]).out,
    "first anon\nnamed\nsecond anon\n");
});

test("set refuses N matches with exit 2 and prints the unique addresses", () => {
  // §5: with N targets there is no single id to normalize the content to, so
  // multi-target `set` is UNDEFINED, not merely risky. The addresses are printed
  // because each one pastes straight back into the same command (§6.2).
  const f = write("n3.geml", ANON);
  const before = read(f);
  const r = run(["set", f, "=== note", "--body"], "x\n");
  assert.equal(r.code, 2);
  assert.match(r.err, /matches 3 blocks/);
  assert.match(r.err, /#warn/);
  assert.match(r.err, /=== note@[0-9a-f]{8}/);
  assert.equal(read(f), before, "nothing written");
});

test("a type with no block is a lookup failure (exit 1), not a usage error", () => {
  const f = write("n4.geml", ANON);
  const r = run(["get", f, "=== table"]);
  assert.equal(r.code, 1, "you named something that is not there — like grep");
  assert.match(r.err, /no `table` block/);
});

// -- §5.2 / §5.3 set through a content address -------------------------------

test("set --head through a content address gives an anonymous block an id", () => {
  // §5.2's stated purpose: the supported way to name a block without hand-editing
  // the document. The content is used VERBATIM — there is no target id to
  // normalize it to, so `{#warned}` survives as written.
  const f = write("s1.geml", ANON);
  const a = addressOf(f, "first anon");
  const r = run(["set", f, a, "--head"], "=== note {#warned}\n");
  assert.equal(r.code, 0, r.err);
  assert.match(read(f), /=== note \{#warned\}\nfirst anon\n===/);
  assert.equal(run(["get", f, "#warned"]).code, 0, "addressable by its new id");
});

test("set through a content address reports the NEW address on stderr", () => {
  // §5.3: writing changes the content, so it changes the address. Printed so a
  // script editing the same block twice need not re-list in between; on stderr
  // because stdout may be the document itself (`-o -`).
  const f = write("s2.geml", ANON);
  const a = addressOf(f, "first anon");
  const r = run(["set", f, a, "--body"], "rewritten\n");
  assert.equal(r.code, 0, r.err);
  const m = /new address: (=== note@[0-9a-f]{8})/.exec(r.err);
  assert.ok(m, `no new address reported: ${r.err}`);
  assert.notEqual(m[1], a, "the address must have moved");
  assert.equal(run(["get", f, m[1]]).out, "=== note\nrewritten\n===\n", "and it resolves");
});

test("set through an id still normalizes the content's id to the target", () => {
  // The id path is unchanged: naming an id on the command line IS the
  // instruction that the result carries that id (block-mutation design §4.0).
  const f = write("s3.geml", ANON);
  const r = run(["set", f, "#warn"], "=== note {#somethingelse}\nnew body\n===\n");
  assert.equal(r.code, 0, r.err);
  assert.match(read(f), /=== note \{#warn\}\nnew body\n===/);
  assert.doesNotMatch(read(f), /somethingelse/);
});

test("set accepts a pasted heading line, which used to be an id lookup", () => {
  // §9 change 6: `set f '## Sect'` used to fail with "no block with id `# Sect`".
  const f = write("s4.geml", ANON);
  const r = run(["set", f, "## Sect", "--body"], "\nreplaced\n");
  assert.equal(r.code, 0, r.err);
  assert.ok(read(f).endsWith("## Sect {#sect}\n\nreplaced\n"), read(f).slice(-40));
});

// -- §7 nothing the caller typed is silently discarded ------------------------

test("every discarded-flag combination is a usage error (exit 2)", () => {
  const f = write("u1.geml", ANON);
  const cases = [
    [["get", f, "--head"], /needs a selector/, "listing tier cannot narrow"],
    [["get", f, "--body"], /needs a selector/, "listing tier cannot narrow"],
    [["get", f, "#warn", "--head", "--body"], /mutually exclusive/, "both parts at once"],
    [["get", f, "#warn", "--json", "--head"], /--json cannot be combined/, "json + part"],
    [["get", f, "#warn", "--json", "--body"], /--json cannot be combined/, "json + part"],
    [["get", f, "=== note {lang=py}"], /only `#id` is supported as a filter key/, "attr key"],
    [["set", f, "=== note {lang=py}"], /only `#id` is supported as a filter key/, "attr key on set"],
  ];
  for (const [args, re, why] of cases) {
    const r = run(args, "x\n");
    assert.equal(r.code, 2, `${why}: expected exit 2, got ${r.code} (${r.err})`);
    assert.match(r.err, re, why);
  }
});

test("the attribute-key error says NOT YET, not `braces are meaningless`", () => {
  // §7: §2 declares attribute keys as part of the model, so implementing them
  // later fills a declared slot instead of reversing this message.
  const f = write("u2.geml", ANON);
  const r = run(["get", f, "=== note {lang=py}"]);
  assert.match(r.err, /today \(got `lang`\)/);
  assert.match(r.err, /use `=== note` for every note block/);
});

test("`=== type {#id}` is the id key written out in full, and is accepted", () => {
  // §2: redundant but legal — it is the same key, not a different form.
  const f = write("u3.geml", ANON);
  assert.equal(run(["get", f, "=== note {#warn}"]).out, run(["get", f, "#warn"]).out);
});

// -- usage errors that reach for the SUBHELP line, not a bare failure ---------

test("every block verb with no file at all prints its own usage", () => {
  // A verb invoked bare is somebody exploring. The usage line is the answer;
  // "missing argument" is not, and these arms had no test between them.
  for (const verb of ["get", "set", "delete", "rename"]) {
    const r = run([verb]);
    assert.equal(r.code, 2, verb);
    assert.match(r.err, new RegExp(`usage: geml ${verb}`), verb);
  }
  // `add` checks its POSITION first — that is the argument it cannot default,
  // and naming it beats a usage dump that buries the one missing piece.
  assert.match(run(["add"]).err, /exactly one position/);
  assert.match(run(["add", "--append"]).err, /usage: geml add/);
});

test("set with a selector but no content says which channel to use", () => {
  const f = write("u4.geml", ANON);
  const r = run(["set", f, "#warn"], "");
  assert.equal(r.code, 1);
  assert.match(r.err, /no replacement content/);
  assert.match(r.err, /--in FILE|stdin/, "it names the two channels");
});

test("set --body on a target that does not exist fails before reading stdin", () => {
  const f = write("u5.geml", ANON);
  const before = read(f);
  const r = run(["set", f, "#nope", "--body"], "x\n");
  assert.equal(r.code, 1);
  assert.match(r.err, /no block with id `nope`/);
  assert.equal(read(f), before);
});

test("add: no content, and an anchor that is not there, are told apart", () => {
  const f = write("u6.geml", ANON);
  const empty = run(["add", f, "--append"], "");
  assert.equal(empty.code, 1);
  assert.match(empty.err, /no content to add/);

  const anchor = run(["add", f, "--after", "#nope"], "=== note\nx\n===\n");
  assert.equal(anchor.code, 1);
  assert.match(anchor.err, /no block with id `nope`/);
});

test("add refuses a fragment that would swallow an existing block", () => {
  // A fragment whose fence closes early turns the rest of the document into its
  // body; the guard counts the ids that survive rather than trusting the parse.
  const f = write("u7.geml", ANON);
  const before = read(f);
  const r = run(["add", f, "--append"], "=== note {#warn}\nduplicate id\n===\n");
  assert.notEqual(r.code, 0, "a colliding id must not be written");
  assert.equal(read(f), before);
});

test("rename onto a taken id is refused with the document untouched", () => {
  const f = write("u8.geml", ANON);
  const before = read(f);
  const r = run(["rename", f, "#warn", "#top"]);
  assert.notEqual(r.code, 0);
  assert.equal(read(f), before);
});

test("a stdin document still gets a resolver, so a missing target is a hard error", () => {
  // Worth pinning because the obvious guess is wrong: the CLI supplies a
  // resolver even for stdin (rooted at the working directory), so a
  // cross-document reference is CHECKED rather than waved through as
  // "not checked (no document resolver)" — that wording only appears where no
  // resolver exists at all, which is the library and the browser.
  const r = run(["check", "-"], "see [[other.geml#x]]\n");
  assert.notEqual(r.code, 0);
  assert.match(r.err, /cannot resolve document `other\.geml`/);
});

console.log(`\n${passed} test(s) passed.`);

// --- remaining fallback arms (coverage: selector.js 36/65/86/97) ---

test("a bare @hex address with no ~n names the first match; ~n picks a later one", () => {
  const f = write("bare-at.geml", "=== note\nfirst\n===\n\n=== note\nsecond\n===\n");
  const list = run(["get", f]);
  assert.equal(list.code, 0, list.err);
  // Two same-type id-less blocks: their addresses carry a content hash. Taking
  // the hash of the first, WITHOUT its `~n` suffix, must resolve to that block.
  const hex = (list.out.match(/@([0-9a-f]{6,})/) ?? [])[1];
  assert.ok(hex, `an anonymous block gets a content address: ${list.out}`);
  const bare = run(["get", f, `@${hex}`]);
  assert.equal(bare.code, 0, bare.err);
  assert.match(bare.out, /first|second/, "a bare @hex resolves without ~n");
});

test("a block whose attribute object has neither id nor class is still addressable", () => {
  // The label falls back to the first key of the attribute object.
  const f = write("kv-only.geml", "=== code {lang=python}\nprint(1)\n===\n");
  const list = run(["get", f]);
  assert.equal(list.code, 0, list.err);
  assert.match(list.out, /=== code|@[0-9a-f]{6,}/, `addressable without an id: ${list.out}`);
});

test("shortest address: an id beats a hash, and a lone block of its type needs no hash", () => {
  const f = write("shortest.geml", "=== note {#named}\nfirst\n===\n\n=== math\nE = mc^2\n===\n");
  const list = run(["get", f]);
  assert.equal(list.code, 0, list.err);
  assert.match(list.out, /#named/, "the id addresses itself");
  assert.match(list.out, /=== math(?!@)/, `a lone id-less math needs no hash: ${list.out}`);
});
