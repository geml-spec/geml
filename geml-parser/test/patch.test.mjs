// `geml patch` — many replacements as ONE transaction.
// Design: docs/design/specs/2026-08-07-geml-batch-edit-design.md
//
// The tests that matter most are the ones asserting the file did NOT change:
// what a batch buys over a run of `set` calls is not saved process starts, it
// is that a failure anywhere leaves nothing half-edited.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const CLI = "dist/geml.js";
function run(args, input) {
  const r = spawnSync(process.execPath, [CLI, ...args], { input: input ?? "", encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const DOC = "=== meta\ntitle = \"t\"\n===\n\n# Intro {#intro}\n\nold opening\n\n## Detail {#detail}\n\n"
  + "=== table {#tbl}\n| a | b |\n| :- | :- |\n| 1 | 2 |\n===\n\n=== note {#n}\nold note\n===\n";

function ws(doc = DOC) {
  const dir = mkdtempSync(join(tmpdir(), "geml-patch-"));
  const f = join(dir, "d.geml");
  writeFileSync(f, doc);
  return { dir, f, patch: (text) => { const p = join(dir, "p.geml"); writeFileSync(p, text); return p; } };
}

test("one patch replaces many blocks in one call", () => {
  const { dir, f, patch } = ws();
  const p = patch("=== patch {target=\"#n\" part=body}\nNEW note\n===\n\n"
    + "=== patch {target=\"#tbl\" part=body}\n| x | y |\n| :- | :- |\n| 9 | 8 |\n===\n");
  const r = run(["patch", f, "--in", p, "-o", f]);
  assert.equal(r.code, 0, r.err);
  const after = readFileSync(f, "utf8");
  assert.match(after, /NEW note/);
  assert.match(after, /\| 9 \| 8 \|/);
  assert.doesNotMatch(after, /old note/);
  assert.match(r.err, /patched 2 blocks/);
  rmSync(dir, { recursive: true, force: true });
});

test("a patch document is a GEML document, and checks clean", () => {
  // The design's hardest constraint: no second syntax. `target=`/`part=` are
  // known attributes, so a patch does not check with warnings either.
  const { dir, patch } = ws();
  const p = patch("=== patch {target=\"#n\"}\nx\n===\n\n=== patch {target=\"#intro\" part=intro}\ny\n===\n");
  const r = run(["check", p]);
  assert.equal(r.code, 0);
  assert.match(r.out + r.err, /no diagnostics/);
  rmSync(dir, { recursive: true, force: true });
});

test("a target matching nothing writes nothing at all", () => {
  const { dir, f, patch } = ws();
  const before = readFileSync(f, "utf8");
  const p = patch("=== patch {target=\"#n\"}\nfine\n===\n\n=== patch {target=\"#nope\"}\nbad\n===\n");
  const r = run(["patch", f, "--in", p, "-o", f]);
  assert.notEqual(r.code, 0);
  assert.equal(readFileSync(f, "utf8"), before, "the FIRST instruction must not have landed either");
  rmSync(dir, { recursive: true, force: true });
});

test("a target matching several blocks writes nothing at all", () => {
  const { dir, f, patch } = ws();
  const before = readFileSync(f, "utf8");
  const p = patch("=== patch {target=\"=== patch\"}\nx\n===\n");
  const r = run(["patch", f, "--in", p, "-o", f]);
  assert.notEqual(r.code, 0);
  assert.equal(readFileSync(f, "utf8"), before);
  rmSync(dir, { recursive: true, force: true });
});

test("a patch that would break the document is abandoned whole", () => {
  const { dir, f, patch } = ws();
  const before = readFileSync(f, "utf8");
  const p = patch("=== patch {target=\"#n\"}\n=== note {#n}\nok\n===\n===\n\n"
    + "=== patch {target=\"#tbl\"}\n=== code {#tbl}\nunterminated\n===\n");
  const r = run(["patch", f, "--in", p, "-o", f]);
  assert.equal(r.code, 1);
  assert.match(r.err, /would not parse/);
  assert.equal(readFileSync(f, "utf8"), before, "including the instruction that was fine");
  rmSync(dir, { recursive: true, force: true });
});

test("two instructions that overlap are refused rather than ordered", () => {
  // `#intro`'s opening region contains `#n` when nothing separates them, so
  // which of the two wins would depend on application order — something the
  // patch file says nothing about.
  const flat = "=== meta\ntitle = \"t\"\n===\n\n# Intro {#intro}\n\nlead\n\n=== note {#n}\nx\n===\n";
  const { dir, f, patch } = ws(flat);
  const before = readFileSync(f, "utf8");
  const p = patch("=== patch {target=\"#intro\" part=intro}\nA\n===\n\n=== patch {target=\"#n\"}\nB\n===\n");
  const r = run(["patch", f, "--in", p, "-o", f]);
  assert.equal(r.code, 2);
  assert.match(r.err, /overlap/);
  assert.equal(readFileSync(f, "utf8"), before);
  rmSync(dir, { recursive: true, force: true });
});

test("part=intro behaves exactly as `set --intro`, blank lines included", () => {
  // One semantic, one behaviour: a patch and a set of the same region have to
  // produce the same bytes, or the two verbs disagree about what a region is.
  const viaPatch = ws(); const viaSet = ws();
  const p = viaPatch.patch("=== patch {target=\"#intro\" part=intro}\nNEW opening\n===\n");
  assert.equal(run(["patch", viaPatch.f, "--in", p, "-o", viaPatch.f]).code, 0);
  assert.equal(run(["set", viaSet.f, "#intro", "--intro", "-o", viaSet.f], "NEW opening\n").code, 0);
  assert.equal(readFileSync(viaPatch.f, "utf8"), readFileSync(viaSet.f, "utf8"));
  rmSync(viaPatch.dir, { recursive: true, force: true });
  rmSync(viaSet.dir, { recursive: true, force: true });
});

test("a CRLF document is still CRLF after a patch written with LF", () => {
  const { dir, f, patch } = ws(DOC.replace(/\n/g, "\r\n"));
  const p = patch("=== patch {target=\"#n\" part=body}\nNEW note body\n===\n");
  assert.equal(run(["patch", f, "--in", p, "-o", f]).code, 0);
  const after = readFileSync(f, "utf8");
  assert.match(after, /NEW note body/);
  assert.equal((after.match(/(?<!\r)\n/g) ?? []).length, 0, "not one lone LF may be introduced");
  rmSync(dir, { recursive: true, force: true });
});

test("a patch with no instructions, and one that does not parse, are both refused", () => {
  const { dir, f, patch } = ws();
  const before = readFileSync(f, "utf8");
  const empty = run(["patch", f, "--in", patch("=== note {#x}\njust a note\n===\n"), "-o", f]);
  assert.equal(empty.code, 1);
  assert.match(empty.err, /no `=== patch` blocks/);
  const broken = run(["patch", f, "--in", patch("=== patch {target=\"#n\"}\nunterminated\n"), "-o", f]);
  assert.notEqual(broken.code, 0);
  assert.match(broken.err, /does not parse/);
  assert.equal(readFileSync(f, "utf8"), before);
  rmSync(dir, { recursive: true, force: true });
});

test("an instruction with no target, or an unknown part, is a usage error", () => {
  const { dir, f, patch } = ws();
  const noTarget = run(["patch", f, "--in", patch("=== patch\nx\n===\n"), "-o", f]);
  assert.equal(noTarget.code, 2);
  assert.match(noTarget.err, /no `target=`/);
  const badPart = run(["patch", f, "--in", patch("=== patch {target=\"#n\" part=middle}\nx\n===\n"), "-o", f]);
  assert.equal(badPart.code, 2);
  assert.match(badPart.err, /whole\|head\|intro\|body/);
  rmSync(dir, { recursive: true, force: true });
});

test("part=intro on a block, not a heading, is refused before anything moves", () => {
  const { dir, f, patch } = ws();
  const before = readFileSync(f, "utf8");
  const r = run(["patch", f, "--in", patch("=== patch {target=\"#n\" part=intro}\nx\n===\n"), "-o", f]);
  assert.equal(r.code, 2);
  assert.match(r.err, /heading's opening region/);
  assert.equal(readFileSync(f, "utf8"), before);
  rmSync(dir, { recursive: true, force: true });
});

test("blocks a patch removes are reported, as `set` reports them", () => {
  const flat = "=== meta\ntitle = \"t\"\n===\n\n# Intro {#intro}\n\nlead\n\n=== note {#n}\nx\n===\n\n## Sub {#sub}\n\ns\n";
  const { dir, f, patch } = ws(flat);
  const r = run(["patch", f, "--in", patch("=== patch {target=\"#intro\" part=intro}\njust prose now\n===\n"), "-o", f]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /dropped `#n`/);
  assert.match(r.err, /geml revert/);
  rmSync(dir, { recursive: true, force: true });
});

console.log(`patch: ${passed} passed`);
