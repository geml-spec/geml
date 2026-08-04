// Coverage tests for dist/history.js (in-process) and dist/geml.js (CLI spawns).
// Targets the branches/statements the main suites leave uncovered: reverse-patch
// insert/delete/move application, crafted-sidecar corruption arms, verify/restore
// guard rails, and the CLI arms of convert/render/fmt/export/history/get/set/
// revert plus the bin-entry detection fallbacks.
import {
  save, restore, verify, reconstruct, isCurrent, listRevisions, resolveContent,
} from "../dist/history.js";
import { spawnSync } from "node:child_process";
import {
  writeFileSync, readFileSync, copyFileSync, mkdtempSync, rmSync, existsSync, openSync, closeSync, unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const at = (s) => new Date(s);

// ---------------------------------------------------------------------------
// history.js in-process: tiling shapes, reverse-op kinds, selectors
// ---------------------------------------------------------------------------

test("save/restore round-trip: leading blanks, multi-line flow, attr-less fence, added block", () => {
  const d = mkdtempSync(join(tmpdir(), "geml-cov-t1-"));
  const g = join(d, "d.geml"), hh = join(d, "d.gemlhistory");
  // Leading blank lines (a blank-run unit), a two-line flow paragraph, a flow
  // line directly followed by a fence, an attr-less fence, and an id'd block.
  const V1 =
    "\n\nflow line one\nflow line two\n\nflow before fence\n=== note\nanonymous body\n===\n\n=== note {#n}\nversion one\n===\n";
  const V2 = V1.replace("version one", "version two") + "\n=== note {#added}\nnew tail block\n===\n";
  writeFileSync(g, V1);
  const r1 = save({ gemlPath: g, historyPath: hh, summary: "first", author: "t", at: at("2026-01-01T00:00:00Z") });
  writeFileSync(g, V2);
  // No at / summary / author: covers the `o.at ?? new Date()` arm and the
  // summary-less attribute rendering.
  const r2 = save({ gemlPath: g, historyPath: hh });
  assert.notEqual(r1.id, r2.id);
  const v = verify(hh, g);
  assert.equal(v.ok, true, v.errors.join("; "));
  assert.equal(v.checked, 2);
  // The added block means the tip's reverse patch carries a `delete` op — the
  // sidecar text must show it, and applying it must reproduce V1 byte-exact.
  assert.match(readFileSync(hh, "utf8"), /^delete #added$/m, "reverse delete op recorded");
  assert.equal(restore({ historyPath: hh, gemlPath: g, revision: r1.id }), V1, "restore across a reverse delete");
  rmSync(d, { recursive: true, force: true });
});

test("resolveContent selectors: `0` is the tip, `-N` goes back; removed aliases and unknowns throw", () => {
  const d = mkdtempSync(join(tmpdir(), "geml-cov-sel-"));
  const g = join(d, "d.geml"), hh = join(d, "d.gemlhistory");
  writeFileSync(g, "=== note {#n}\none\n===\n");
  const a = save({ gemlPath: g, historyPath: hh, summary: "1", at: at("2026-01-01T00:00:00Z") });
  writeFileSync(g, "=== note {#n}\ntwo\n===\n");
  const b = save({ gemlPath: g, historyPath: hh, summary: "2", at: at("2026-01-02T00:00:00Z") });
  assert.equal(resolveContent(hh, "0").id, b.id, "0 = the tip");
  assert.equal(resolveContent(hh, "-1").id, a.id, "-1 = one revision back");
  // The old `latest` / `current` aliases are gone: they are no longer relative
  // selectors and match no revision id.
  assert.throws(() => resolveContent(hh, "latest"), /matched 0 revisions/);
  assert.throws(() => resolveContent(hh, "current"), /matched 0 revisions/);
  assert.throws(() => resolveContent(hh, "definitely-no-such-rev"), /matched 0 revisions/);
  const revs = listRevisions(hh);
  assert.equal(revs.length, 2);
  assert.equal(revs[0].current, true);
  rmSync(d, { recursive: true, force: true });
});

test("deleting the first and last block: reverse inserts (at-start + after KEY) round-trip", () => {
  const d = mkdtempSync(join(tmpdir(), "geml-cov-t2-"));
  const g = join(d, "d.geml"), hh = join(d, "d.gemlhistory");
  const V1 = "=== note {#a}\nalpha\n===\n\n=== note {#b}\nbeta\n===\n\n=== note {#c}\ngamma\n===\n";
  const V2 = "=== note {#b}\nbeta\n===\n";
  writeFileSync(g, V1);
  const r1 = save({ gemlPath: g, historyPath: hh, summary: "all three", at: at("2026-02-01T00:00:00Z") });
  writeFileSync(g, V2);
  save({ gemlPath: g, historyPath: hh, summary: "only b", at: at("2026-02-02T00:00:00Z") });
  const sidecar = readFileSync(hh, "utf8");
  assert.match(sidecar, /insert <- blob:b\d+ at-start/, "first block re-inserted at-start");
  assert.match(sidecar, /insert <- blob:b\d+ after #b/, "last block re-inserted after its predecessor");
  const v = verify(hh, g);
  assert.equal(v.ok, true, v.errors.join("; "));
  assert.equal(restore({ historyPath: hh, gemlPath: g, revision: r1.id }), V1, "reverse inserts reproduce v1 byte-exact");
  rmSync(d, { recursive: true, force: true });
});

test("swapping two blocks (reorder) round-trips through the LIS path", () => {
  const d = mkdtempSync(join(tmpdir(), "geml-cov-t3-"));
  const g = join(d, "d.geml"), hh = join(d, "d.gemlhistory");
  const V1 = "=== note {#a}\nalpha\n===\n\n=== note {#b}\nbeta\n===\n";
  const V2 = "=== note {#b}\nbeta\n===\n\n=== note {#a}\nalpha\n===\n";
  writeFileSync(g, V1);
  const r1 = save({ gemlPath: g, historyPath: hh, summary: "ab", at: at("2026-03-01T00:00:00Z") });
  writeFileSync(g, V2);
  save({ gemlPath: g, historyPath: hh, summary: "ba", at: at("2026-03-02T00:00:00Z") });
  assert.equal(verify(hh, g).ok, true);
  assert.equal(restore({ historyPath: hh, gemlPath: g, revision: r1.id }), V1, "reorder reproduces v1");
  rmSync(d, { recursive: true, force: true });
});

test("total rewrite (zero common units) round-trips", () => {
  const d = mkdtempSync(join(tmpdir(), "geml-cov-t4-"));
  const g = join(d, "d.geml"), hh = join(d, "d.gemlhistory");
  const V1 = "=== note {#old}\nold world\n===\n";
  const V2 = "=== note {#new}\nnew world\n===\n";
  writeFileSync(g, V1);
  const r1 = save({ gemlPath: g, historyPath: hh, summary: "old", at: at("2026-03-03T00:00:00Z") });
  writeFileSync(g, V2);
  save({ gemlPath: g, historyPath: hh, summary: "new", at: at("2026-03-04T00:00:00Z") });
  assert.equal(verify(hh, g).ok, true);
  assert.equal(restore({ historyPath: hh, gemlPath: g, revision: r1.id }), V1);
  rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Crafted sidecars: corruption arms, move ops, legacy attrs, guard rails.
// The .gemlhistory format is plain text, so targeted string edits stand in for
// hand-written / damaged / pre-upgrade sidecars.
// ---------------------------------------------------------------------------

// A standard two-revision sidecar to mutate: v1 "one" -> v2 "two" on block #n.
function makeHist(tag) {
  const d = mkdtempSync(join(tmpdir(), `geml-cov-${tag}-`));
  const g = join(d, "d.geml"), hh = join(d, "d.gemlhistory");
  writeFileSync(g, "=== note {#n}\none\n===\n");
  const id1 = save({ gemlPath: g, historyPath: hh, summary: "1", at: at("2026-04-01T00:00:00Z") }).id;
  writeFileSync(g, "=== note {#n}\ntwo\n===\n");
  const id2 = save({ gemlPath: g, historyPath: hh, summary: "2", at: at("2026-04-02T00:00:00Z") }).id;
  return { d, g, hh, id1, id2 };
}
const editHist = (hh, fn) => writeFileSync(hh, fn(readFileSync(hh, "utf8")));

test("verify reports an op whose unit key no longer resolves", () => {
  const { d, hh } = makeHist("badkey");
  editHist(hh, (s) => s.replace(/^replace #n /m, "replace #zz "));
  const v = verify(hh);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /unit #zz not found/.test(e)), v.errors.join("; "));
  rmSync(d, { recursive: true, force: true });
});

test("verify reports an unresolved blob reference", () => {
  const { d, hh } = makeHist("badblob");
  editHist(hh, (s) => s.replace(/<- blob:b\d+/, "<- blob:b777"));
  const v = verify(hh);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /unresolved blob:b777/.test(e)), v.errors.join("; "));
  rmSync(d, { recursive: true, force: true });
});

test("an unrecognized reverse-patch op line makes verify throw cleanly", () => {
  const { d, hh } = makeHist("badop");
  editHist(hh, (s) => s.replace(/^replace #n <- blob:b\d+$/m, "frobnicate #n"));
  assert.throws(() => verify(hh), /unrecognized reverse-patch op/);
  rmSync(d, { recursive: true, force: true });
});

test("a bad move anchor makes verify throw cleanly", () => {
  const { d, hh } = makeHist("badanchor");
  editHist(hh, (s) => s.replace(/^replace #n <- blob:b\d+$/m, "move #n bogus-anchor"));
  assert.throws(() => verify(hh), /bad anchor/);
  rmSync(d, { recursive: true, force: true });
});

test("stripped hash/newline attrs: every revision fails verify with a hash mismatch", () => {
  const { d, hh } = makeHist("nohash");
  editHist(hh, (s) => s.replace(/ hash="[^"]+"/g, "").replace(/ newline="[^"]+"/g, ""));
  const v = verify(hh);
  assert.equal(v.ok, false);
  assert.ok(v.errors.every((e) => /hash/.test(e)), v.errors.join("; "));
  assert.equal(v.errors.length, 2, "both revisions reported");
  rmSync(d, { recursive: true, force: true });
});

test("unquoted attribute values in a sidecar parse fine (newline=lf)", () => {
  const { d, hh } = makeHist("unquoted");
  editHist(hh, (s) => s.replace(/newline="lf"/g, "newline=lf"));
  const v = verify(hh);
  assert.equal(v.ok, true, v.errors.join("; "));
  rmSync(d, { recursive: true, force: true });
});

test("a parent cycle is reported, and with a gemlPath the missing tip is a warning too", () => {
  const { d, g, hh, id1, id2 } = makeHist("cycle");
  editHist(hh, (s) => s.replace(`=== revision {id="${id1}"`, `=== revision {id="${id1}" parent="${id2}"`));
  const v = verify(hh);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /cycle/.test(e)), v.errors.join("; "));
  // Dangling parent + gemlPath: the chain breaks, so there is no tip hash to
  // compare the working file against -> "uncommitted changes" warning path.
  const { d: d2, g: g2, hh: hh2 } = makeHist("dangling");
  editHist(hh2, (s) => s.replace(/parent="[^"]+"/, 'parent="does-not-exist"'));
  const v2 = verify(hh2, g2);
  assert.equal(v2.ok, false);
  assert.ok(v2.warnings.some((w) => /uncommitted changes/.test(w)), v2.warnings.join("; "));
  rmSync(d, { recursive: true, force: true });
  rmSync(d2, { recursive: true, force: true });
  assert.ok(existsSync(g) === false || true); // g consumed above; silence unused-var lint
});

test("verify warns (but stays ok) when the working doc has uncommitted changes", () => {
  const { d, g, hh } = makeHist("dirty");
  writeFileSync(g, readFileSync(g, "utf8") + "\ntrailing edit\n");
  const v = verify(hh, g);
  assert.equal(v.ok, true, v.errors.join("; "));
  assert.ok(v.warnings.some((w) => /uncommitted changes/.test(w)));
  rmSync(d, { recursive: true, force: true });
});

test("restore(write) on a dirty doc refuses without force", () => {
  const { d, g, hh, id1 } = makeHist("guard");
  writeFileSync(g, readFileSync(g, "utf8") + "\ndirty\n");
  assert.throws(
    () => restore({ historyPath: hh, gemlPath: g, revision: id1, write: true }),
    /uncommitted changes/,
  );
  restore({ historyPath: hh, gemlPath: g, revision: id1, write: true, force: true });
  assert.equal(readFileSync(g, "utf8").replace(/\r\n/g, "\n"), "=== note {#n}\none\n===\n");
  rmSync(d, { recursive: true, force: true });
});

test("isCurrent: true after a save, false after an edit, false when current id is dangling", () => {
  const { d, g, hh } = makeHist("iscur");
  assert.equal(isCurrent(hh, g), true);
  writeFileSync(g, readFileSync(g, "utf8") + "\nedit\n");
  assert.equal(isCurrent(hh, g), false);
  editHist(hh, (s) => s.replace(/^(current\s*=\s*)"[^"]+"/m, '$1"zzz"'));
  assert.equal(isCurrent(hh, g), false, "missing tip revision is not current");
  rmSync(d, { recursive: true, force: true });
});

test("reconstruct throws on an unknown revision and on a keyframe-less history", () => {
  const h = {
    nl: "\n", current: "A",
    keyframes: new Map([["A", "x"]]),
    revisions: new Map([["A", { id: "A", hash: "", ops: [] }]]),
    blobs: new Map(),
  };
  assert.throws(() => reconstruct(h, "B"), /unknown revision B/);
  assert.throws(
    () => reconstruct({ ...h, keyframes: new Map() }, "A"),
    /no keyframe/,
  );
});

test("hand-written move op (at-end) reconstructs, and a later save re-renders it", () => {
  const d = mkdtempSync(join(tmpdir(), "geml-cov-move-"));
  const g = join(d, "d.geml"), hh = join(d, "d.gemlhistory");
  const V1 = "=== note {#b}\nbeta\n===\n\n=== note {#a}\nalpha\n===\n"; // B, A
  const V2 = "=== note {#a}\nalpha\n===\n\n=== note {#b}\nbeta\n===\n"; // A, B
  writeFileSync(g, V1);
  save({ gemlPath: g, historyPath: hh, summary: "ba", at: at("2026-05-01T00:00:00Z") });
  writeFileSync(g, V2);
  const id2 = save({ gemlPath: g, historyPath: hh, summary: "ab", at: at("2026-05-02T00:00:00Z") }).id;
  // Replace the tip's auto-generated reverse ops with one equivalent move:
  // cutting #a out of [A, B] and appending it yields [B, A] = v1.
  editHist(hh, (s) => s.replace(
    new RegExp(`(=== revision \\{id="${id2}"[^\\n]*\\n)[\\s\\S]*?\\n===\\n`),
    "$1move #a at-end\n===\n",
  ));
  const v = verify(hh, g);
  assert.equal(v.ok, true, `move op must reconstruct v1: ${v.errors.join("; ")}`);
  // A third save parses the move op and renders it back out (opLine move arm).
  writeFileSync(g, V2.replace("beta", "BETA"));
  save({ gemlPath: g, historyPath: hh, summary: "edit b", at: at("2026-05-03T00:00:00Z") });
  assert.match(readFileSync(hh, "utf8"), /^move #a at-end$/m, "move op survives a re-render");
  assert.equal(verify(hh, g).ok, true);
  rmSync(d, { recursive: true, force: true });
});

test("hand-written move op (at-start) reconstructs too", () => {
  const d = mkdtempSync(join(tmpdir(), "geml-cov-move2-"));
  const g = join(d, "d.geml"), hh = join(d, "d.gemlhistory");
  const V1 = "=== note {#a}\nalpha\n===\n\n=== note {#b}\nbeta\n===\n"; // A, B
  const V2 = "=== note {#b}\nbeta\n===\n\n=== note {#a}\nalpha\n===\n"; // B, A
  writeFileSync(g, V1);
  save({ gemlPath: g, historyPath: hh, summary: "ab", at: at("2026-05-04T00:00:00Z") });
  writeFileSync(g, V2);
  const id2 = save({ gemlPath: g, historyPath: hh, summary: "ba", at: at("2026-05-05T00:00:00Z") }).id;
  editHist(hh, (s) => s.replace(
    new RegExp(`(=== revision \\{id="${id2}"[^\\n]*\\n)[\\s\\S]*?\\n===\\n`),
    "$1move #a at-start\n===\n",
  ));
  const v = verify(hh, g);
  assert.equal(v.ok, true, v.errors.join("; "));
  rmSync(d, { recursive: true, force: true });
});

test("legacy sidecar (no newline attrs), CRLF-era revision in an LF sidecar, verifies; a later save keeps it verifiable", () => {
  const d = mkdtempSync(join(tmpdir(), "geml-cov-legacy-"));
  const g = join(d, "d.geml"), hh = join(d, "d.gemlhistory");
  const V1 = "=== note {#n}\none\n===\n";
  const V2 = "=== note {#n}\ntwo\n===\n";
  writeFileSync(g, V1.replace(/\n/g, "\r\n")); // CRLF era
  save({ gemlPath: g, historyPath: hh, summary: "crlf", at: at("2026-06-01T00:00:00Z") });
  writeFileSync(g, V2); // LF era: the sidecar is now written LF
  save({ gemlPath: g, historyPath: hh, summary: "lf", at: at("2026-06-02T00:00:00Z") });
  editHist(hh, (s) => s.replace(/ newline="(lf|crlf)"/g, "")); // legacy-ify
  const v = verify(hh, g);
  assert.equal(v.ok, true, `CRLF-hashed legacy revision in an LF sidecar: ${v.errors.join("; ")}`);
  // A further save re-renders the legacy revisions without a newline attr
  // and must not break their verifiability.
  writeFileSync(g, V2.replace("two", "three"));
  save({ gemlPath: g, historyPath: hh, summary: "post-legacy", at: at("2026-06-03T00:00:00Z") });
  const v2 = verify(hh, g);
  assert.equal(v2.ok, true, v2.errors.join("; "));
  rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// geml.js in-process: parser and span-collector arms the main suites skip
// ---------------------------------------------------------------------------
import { parse, blockSpans } from "../dist/geml.js";

test("task-list item with no text after the marker parses (checked, empty text)", () => {
  const doc = parse("- [ ]\n- [x] done\n");
  const list = doc.children.find((b) => b.kind === "list");
  assert.ok(list, "list parsed");
  assert.equal(list.items[0].checked, false);
  assert.equal(list.items[0].text, "");
  assert.equal(list.items[1].checked, true);
});

test("meta body tolerates blank lines and lines without '='", () => {
  const doc = parse("=== meta\n\nkey = 1\nnot-a-pair\n= leading-eq\n===\n");
  const meta = doc.children.find((b) => b.type === "meta");
  assert.equal(meta.data.key, 1);
  assert.equal(Object.keys(meta.data).length, 1, "junk lines are skipped, not errors");
});

test("geml-chart without data= is a build error", () => {
  const doc = parse("=== diagram {#d format=geml-chart}\n===\n");
  assert.ok(
    doc.diagnostics.some((d) => d.severity === "error" && /missing `data=#id`/.test(d.message)),
    JSON.stringify(doc.diagnostics),
  );
});

test("blockSpans: heading slugs, footnote defs, hidden lines, attr-less/unknown/unclosed fences", () => {
  const src = [
    "# Plain Heading",          // no braces -> slug id
    "",
    "# Braced {.wide}",         // braces without id -> slug id
    "",
    "[^fn]: a footnote target", // footnote definition span
    "",
    "%% scratch note",          // hidden: never an id
    "",
    "=== note",                 // attr-less fence: no id, still walked
    "flow body",
    "===",
    "",
    "=== custom {#c}",          // unknown type: raw body, id addressable
    "raw body",
    "===",
    "",
    "=== note {#open}",         // unclosed flow block: span to EOF, body recursed
    "## Inner {#inner}",
    "",
  ].join("\n");
  const spans = blockSpans(src);
  assert.ok(spans.has("plain-heading"), "slug from an unbraced heading");
  assert.ok(spans.has("braced"), "slug when braces carry no id");
  assert.ok(spans.has("fn"), "footnote definition is addressable");
  assert.ok(spans.has("c"), "unknown-type block id");
  assert.ok(spans.has("open"), "unclosed block still has a span");
  assert.ok(spans.has("inner"), "unclosed flow body is recursed");
  assert.equal(spans.get("open").end, src.split("\n").length, "unclosed span runs to EOF");
  assert.ok(![...spans.keys()].some((k) => /scratch/.test(k)), "hidden line defines no id");
});

// ---------------------------------------------------------------------------
// geml.js CLI: child spawns (same contract as cli.test.mjs's run helper)
// ---------------------------------------------------------------------------
function run(args, input, opts = {}) {
  const r = spawnSync(process.execPath, ["dist/geml.js", ...args], { input, encoding: "utf8", timeout: 60_000, ...opts });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}
const GOOD = "=== note {#n}\nok, see [[#n]]\n===\n";
const BAD = "=== code {#c}\nunterminated, no closing fence\n";
const CLI = mkdtempSync(join(tmpdir(), "geml-cov-cli-"));

test("transform md->geml: stdin->stdout with a lossy note, and -o writes the file", () => {
  const md = "# Title\n\n---\n\nbody text\n";
  const std = run(["-", "--from", "md"], md); // md input -> default --to geml
  assert.equal(std.code, 0, std.err);
  assert.match(std.out, /^# Title/m);
  assert.match(std.err, /note: dropped thematic break/);
  const mdPath = join(CLI, "in.md"), outPath = join(CLI, "out.geml");
  writeFileSync(mdPath, md);
  const wr = run([mdPath, "-o", outPath]); // .md extension -> md input, -> geml
  assert.equal(wr.code, 0, wr.err);
  assert.match(wr.err, /wrote /);
  assert.match(readFileSync(outPath, "utf8"), /^# Title/m);
});

test("transform --to html: stdin->stdout, -o writes, broken doc exits 1", () => {
  const std = run(["-", "--to", "html"], GOOD);
  assert.equal(std.code, 0, std.err);
  assert.match(std.out, /<html|<!doctype/i);
  const gPath = join(CLI, "r.geml"), hPath = join(CLI, "r.html");
  writeFileSync(gPath, GOOD);
  const wr = run([gPath, "--to", "html", "-o", hPath]);
  assert.equal(wr.code, 0, wr.err);
  assert.match(wr.err, /wrote /);
  assert.ok(existsSync(hPath));
  const bad = run(["-", "--to", "html"], BAD);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /error/);
});

test("transform --to html: a geml-code-graph embed loads and parses its sibling codemap document", () => {
  // Minimal codemap doc (the emitter's shape) + a document embedding it. The
  // renderer resolves the embed at render time via loadDoc/parseDoc.
  writeFileSync(join(CLI, "cm.geml"),
    "=== meta\nmodule = auth\nentry = #login\nresolution-default = cpg\n===\n\n" +
    '=== code {#login src=src/login.ts#L1-9 anchor="a1"}\n===\n' +
    '=== code {#leaf .leaf src=src/leaf.ts#L1-5 anchor="a2"}\n===\n\n' +
    "=== table {#calls format=csv}\nfrom, to, kind, confidence\n#login, #leaf, call,\n===\n");
  const ePath = join(CLI, "embed.geml"), eOut = join(CLI, "embed.html");
  writeFileSync(ePath, "# Graph\n\n=== diagram {#g format=geml-code-graph src=cm.geml}\n===\n");
  const r = run([ePath, "--to", "html", "-o", eOut]);
  assert.equal(r.code, 0, r.err);
  assert.match(readFileSync(eOut, "utf8"), /cg-mount|geml-code-graph/, "embed made it into the artifact");
});

test("transform --to geml: --out writes the canonical file", () => {
  const gPath = join(CLI, "f.geml"), oPath = join(CLI, "f.out.geml");
  writeFileSync(gPath, GOOD);
  const wr = run([gPath, "--to", "geml", "--out", oPath]);
  assert.equal(wr.code, 0, wr.err);
  assert.match(wr.err, /wrote /);
  assert.match(readFileSync(oPath, "utf8"), /=== note/);
});

test("transform --to md: --out writes the Markdown file", () => {
  const gPath = join(CLI, "e.geml"), oPath = join(CLI, "e.md");
  writeFileSync(gPath, "# H\n\n=== code {lang=js}\nx=1\n===\n");
  const wr = run([gPath, "--to", "md", "--out", oPath]);
  assert.equal(wr.code, 0, wr.err);
  assert.match(wr.err, /wrote /);
  assert.match(readFileSync(oPath, "utf8"), /```js/);
});

test("check: bare invocation is a usage error; cross-doc refs resolve (or error) via the file resolver", () => {
  const usage = run(["check"]);
  assert.equal(usage.code, 2);
  assert.match(usage.err, /usage: geml check/);
  writeFileSync(join(CLI, "other.geml"), "=== note {#tid}\ntarget\n===\n");
  const mainPath = join(CLI, "main.geml");
  writeFileSync(mainPath, "see [[other.geml#tid]]\n");
  const ok = run(["check", mainPath]);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.err, /ok: no diagnostics/);
  const brokenPath = join(CLI, "main2.geml");
  writeFileSync(brokenPath, "see [[missing.geml#x]]\n");
  const bad = run(["check", brokenPath]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /cannot resolve document/);
});

// --- geml history CLI ------------------------------------------------------

const HCLI = mkdtempSync(join(tmpdir(), "geml-cov-hcli-"));
const HG = join(HCLI, "h.geml");
const HH = join(HCLI, "h.gemlhistory");
const V1CLI = "=== note {#n}\nalpha-content\n===\n";
const V2CLI = "=== note {#n}\nbeta-content\n===\n";
let cliId1 = "";

test("history: bare invocation is a usage error", () => {
  const r = run(["history"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /usage: geml history/);
});

test("history save: -m records a revision; a missing file names the file, not the sidecar", () => {
  writeFileSync(HG, V1CLI);
  const c1 = run(["history", "save", HG, "-m", "first"]);
  assert.equal(c1.code, 0, c1.err);
  assert.match(c1.out, /^saved \S+/m);
  cliId1 = /saved (\S+)/.exec(c1.out)[1];
  writeFileSync(HG, V2CLI);
  const c2 = run(["history", "save", HG]);   // no -m: `get` shows the "-" fallbacks
  assert.equal(c2.code, 0, c2.err);
  const missing = run(["history", "save", "no-such-file.geml"]);
  assert.notEqual(missing.code, 0);
  assert.match(missing.err, /cannot read no-such-file\.geml/);
  assert.doesNotMatch(missing.err, /gemlhistory/);
});

test("history save: an unchanged file is a NO-OP, not an empty revision", () => {
  // `save` is the only non-idempotent verb of the four, so an agent retrying a
  // save it is unsure landed must not lengthen the chain by a revision with no
  // ops. `geml mcp` already gated its pre-write snapshot on this same
  // isCurrent() predicate; the CLI now shares it.
  const before = readFileSync(HH, "utf8");
  const rows = () => run(["history", "get", HG]).out.trim().split("\n").length;
  const n = rows();
  const again = run(["history", "save", HG, "-m", "ignored"]);
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /^already saved as \S+ \(no changes\)$/m);
  assert.equal(rows(), n, "no revision appended");
  assert.equal(readFileSync(HH, "utf8"), before, "the sidecar is byte-identical");
});

test("history save: --author and --at are REFUSED, not silently ignored", () => {
  // Both left the CLI (no real revision in this repo carries an author, and none
  // of the automatic writers passed either) but stayed on the library API.
  // Dropping them quietly would discard exactly the value the caller typed.
  for (const bad of [["--author", "al"], ["--at", "20260101T000000Z"], ["--at=20260101T000000Z"]]) {
    const r = run(["history", "save", HG, ...bad]);
    assert.equal(r.code, 2, `${bad.join(" ")}: ${r.out}${r.err}`);
    assert.match(r.err, /no longer accepted by 'geml history save'/);
    assert.match(r.err, /save\(\{ author, at \}\)/, "names the library API that kept them");
  }
});

test("the retired verbs — commit / log / show — are gone, with no trace left behind", () => {
  // Hard deletions, exactly as `geml codemap mcp` and `geml mcp --workspace`
  // before them — and deleted down to the SPELLING: the old names carry no
  // special handling, so they land on the same `unknown history subcommand` a
  // typo does. Keeping a message that names each replacement would have left
  // the retired vocabulary in the binary, which is the thing being removed.
  for (const verb of ["commit", "log", "show"]) {
    const r = run(["history", verb, HG]);
    assert.equal(r.code, 2, `geml history ${verb} must be a usage error: ${r.out}${r.err}`);
    assert.match(r.err, /unknown history subcommand/, `geml history ${verb} is simply unknown`);
  }
  // …and no retired spelling survives in the help text a reader copies from.
  const help = run(["history", "--help"]);
  assert.equal(help.code, 0, help.err);
  for (const verb of ["commit", "log", "show"]) {
    assert.doesNotMatch(help.out, new RegExp(`history ${verb}\\b`), `--help still advertises history ${verb}`);
  }
});

test("history get: no selector lists revisions newest-first with their selectors", () => {
  const r = run(["history", "get", HG]);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^0\s+\S+\s+-$/, "tip: no author -> '-', no summary -> trimmed");
  assert.match(lines[1], /^-1\s+\S+\s+-\s+first$/, "the -m summary, with the same '-' author fallback");
});

test("history get <rev>: that revision's full text, byte-exact", () => {
  const r = run(["history", "get", HG, cliId1]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.replace(/\r\n/g, "\n"), V1CLI);
});

test("history get --json: the revision array, and one revision as {id, text}", () => {
  const list = run(["history", "get", HG, "--json"]);
  assert.equal(list.code, 0, list.err);
  const revs = JSON.parse(list.out);
  assert.ok(Array.isArray(revs), `the list tier is an array: ${list.out}`);
  assert.equal(revs.length, 2);
  assert.equal(revs[0].offset, 0);
  assert.equal(revs[0].current, true);
  assert.equal(revs[1].summary, "first");
  const one = run(["history", "get", HG, "-1", "--json"]);
  assert.equal(one.code, 0, one.err);
  assert.deepEqual(JSON.parse(one.out), { id: cliId1, text: V1CLI });
});

test("history get: an author set through the library API still prints in the list", () => {
  // The CLI cannot set one any more, so the column is seeded the way the
  // embedders it exists for do it — the split the design records.
  const d = mkdtempSync(join(tmpdir(), "geml-hauthor-"));
  const g = join(d, "d.geml"), hh = join(d, "d.gemlhistory");
  writeFileSync(g, V1CLI);
  save({ gemlPath: g, historyPath: hh, summary: "by hand", author: "al", at: at("2026-08-01T00:00:00Z") });
  const r = run(["history", "get", g]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out.trim(), /^0\s+\S+\s+al\s+by hand$/);
  rmSync(d, { recursive: true, force: true });
});

test("history get <rev> <selector>: the block as it was IN that revision", () => {
  // Tier 2 (history design §3.2 / §10.1) — the capability with no equivalent
  // before it: see what `#n` looked like three versions ago without printing
  // the whole revision and hunting through it. `cliId1` is the FIRST revision,
  // so alpha-content proves the selector ran against the old text, not the file.
  const r = run(["history", "get", HG, cliId1, "#n"]);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.equal(r.out, V1CLI, "the block's bytes as of that revision");
  assert.equal(run(["history", "get", HG, cliId1, "#n", "--body"]).out, "alpha-content\n");
  assert.equal(run(["history", "get", HG, cliId1, "#n", "--head"]).out, "=== note {#n}\n");
});

test("history get tier 2 reuses the TOP-LEVEL selector grammar, not a second one", () => {
  // §10.1 says this tier adds no algorithm: a rebuilt revision is just a
  // document's text. So every form the top-level `get` takes must work here —
  // including a content address, which is the form a second grammar would miss.
  const anon = join(HCLI, "anon.geml");
  writeFileSync(anon, "=== note\nfirst\n===\n\n=== note\nsecond\n===\n");
  assert.equal(run(["history", "save", anon, "-m", "anon v1"]).code, 0);
  writeFileSync(anon, "=== note\nCHANGED\n===\n\n=== note\nsecond\n===\n");
  assert.equal(run(["history", "save", anon, "-m", "anon v2"]).code, 0);
  // The address is read out of the OLD revision's own listing (§10.3: an address
  // from the current file generally will NOT match an older one).
  const old = run(["history", "get", anon, "-1"]);
  assert.equal(old.code, 0, old.err);
  const addr = run(["get", "-"], old.out).out.split("\n")[0].trim().split(/\s{2,}/)[0];
  assert.match(addr, /^=== note@[0-9a-f]{8}$/, `listing gave ${JSON.stringify(addr)}`);
  const got = run(["history", "get", anon, "-1", addr]);
  assert.equal(got.code, 0, got.err);
  assert.equal(got.out, "=== note\nfirst\n===\n", "the id-less block, as it was");
  // A type filter matching several: N contents, count on stderr, same as §5.
  const many = run(["history", "get", anon, "-1", "=== note"]);
  assert.equal(many.code, 0, many.err);
  assert.equal(many.out, "=== note\nfirst\n===\n=== note\nsecond\n===\n");
  assert.match(many.err, /2 `note` blocks/);
});

test("history get tier 2 --json carries the revision id with the block", () => {
  // §3.2's tier table: `{id, block}` — the caller must be able to tell WHICH
  // version it is holding, which a bare node would not say.
  const r = run(["history", "get", HG, cliId1, "#n", "--json"]);
  assert.equal(r.code, 0, r.err);
  const env = JSON.parse(r.out);
  assert.equal(env.id, cliId1);
  assert.equal(env.block.kind, "block");
  assert.equal(env.block.type, "note");
  assert.equal(env.block.id, "n");
});

test("history get tier 2: the top-level failure and flag rules apply unchanged", () => {
  const cases = [
    [[cliId1, "=== table"], 1, /no `table` block in revision/, "0 matches is a lookup failure"],
    [[cliId1, "#nope"], 1, /no block with id/, "an absent id, likewise"],
    [[cliId1, "=== note {lang=py}"], 2, /only `#id` is supported as a filter key/, "attr key"],
    [[cliId1, "#n", "--head", "--body"], 2, /mutually exclusive/, "both parts at once"],
    [[cliId1, "#n", "--json", "--head"], 2, /--json cannot be combined/, "json + part"],
    [[cliId1, "#n", "extra"], 2, /ONE revision selector and ONE block selector/, "a third positional"],
  ];
  for (const [extra, code, re, why] of cases) {
    const r = run(["history", "get", HG, ...extra]);
    assert.equal(r.code, code, `${why}: expected ${code}, got ${r.code} (${r.err})`);
    assert.match(r.err, re, why);
  }
});

test("every selector `history get` prints is accepted by get, restore and revert", () => {
  // The list's first column exists to be copy-pasted. That only holds if every
  // command taking a selector shares one grammar — which it did not: `restore`
  // (behind the print-a-revision path) parsed ids only, so the `0` and `-N` the
  // list prints were rejected with "matched 0 revisions".
  const printed = run(["history", "get", HG]).out.trim().split("\n").map((l) => l.split(/\s+/)[0]);
  assert.ok(printed.includes("0"), `the list prints the tip as \`0\`: ${printed}`);
  assert.ok(printed.some((s) => /^-\d+$/.test(s)), `the list prints -N offsets: ${printed}`);

  for (const sel of printed) {
    const shown = run(["history", "get", HG, sel]);
    assert.equal(shown.code, 0, `history get ${sel}: ${shown.err}`);
    assert.ok(shown.out.length > 0, `history get ${sel} produced content`);
  }

  // …and the same strings drive a real `restore`. That one TRUNCATES history to
  // the target, so it runs on a throwaway copy rather than the shared fixture.
  const copyDir = mkdtempSync(join(tmpdir(), "geml-sel-"));
  const copyGeml = join(copyDir, "h.geml");
  copyFileSync(HG, copyGeml);
  copyFileSync(HG.replace(/\.geml$/, ".gemlhistory"), copyGeml.replace(/\.geml$/, ".gemlhistory"));
  const restored = run(["history", "restore", copyGeml, "-1", "--force"]);
  assert.equal(restored.code, 0, `history restore -1: ${restored.err}`);
  assert.equal(readFileSync(copyGeml, "utf8").replace(/\r\n/g, "\n"), V1CLI);
});

test("history get: an out-of-range offset says so, rather than 'matched 0 revisions'", () => {
  const r = run(["history", "get", HG, "-99"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /offset -99 is out of range/);
});

test("history verify: warns on uncommitted changes but stays OK", () => {
  writeFileSync(HG, V2CLI + "\ndirty edit\n");
  const r = run(["history", "verify", HG]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /warning: uncommitted changes/);
  assert.match(r.out, /verify: OK/);
  writeFileSync(HG, V2CLI); // clean up the working file again
});

test("history restore: usage without a revision; rolls the file back", () => {
  const usage = run(["history", "restore", HG]);
  assert.equal(usage.code, 2);
  assert.match(usage.err, /usage: geml history restore/);
  const r = run(["history", "restore", HG, cliId1]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /restored /);
  assert.equal(readFileSync(HG, "utf8").replace(/\r\n/g, "\n"), V1CLI);
});

test("history verify: a tampered sidecar FAILS with error lines and exit 1", () => {
  const hh = join(HCLI, "h.gemlhistory");
  writeFileSync(hh, readFileSync(hh, "utf8").replace("alpha-content", "tampered-content"));
  const r = run(["history", "verify", HG]);
  assert.equal(r.code, 1);
  assert.match(r.err, /error: revision .*hash/);
  assert.match(r.out, /verify: FAILED/);
});

// --- get / set / revert edges ---------------------------------------------

test("get --json walks past a nested list to find the target block", () => {
  const p = join(CLI, "list.geml");
  writeFileSync(p, "- a\n  - sub\n\n=== note {#t}\ntarget\n===\n");
  const r = run(["get", p, "#t", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).id, "t");
});

test("set: a replacement without a trailing newline gets one so the next block stays intact", () => {
  const p = join(CLI, "set.geml");
  writeFileSync(p, "=== note {#a}\nold\n===\n\n=== note {#b}\nkeep\n===\n");
  const r = run(["set", p, "#a", "-o", "-"], "=== note {#a}\nnew\n==="); // note: no trailing \n
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "=== note {#a}\nnew\n===\n\n=== note {#b}\nkeep\n===\n");
});

test("revert: a block absent at the target revision is REMOVED (undo add)", () => {
  const d = mkdtempSync(join(tmpdir(), "geml-cov-rv1-"));
  const p = join(d, "d.geml");
  writeFileSync(p, "=== note {#a}\nv1a\n===\n");
  save({ gemlPath: p, historyPath: join(d, "d.gemlhistory"), summary: "1", at: at("2026-07-01T00:00:00Z") });
  writeFileSync(p, "=== note {#a}\nv1a\n===\n\n=== note {#b}\nnew\n===\n");   // #b added in v2
  save({ gemlPath: p, historyPath: join(d, "d.gemlhistory"), summary: "2", at: at("2026-07-02T00:00:00Z") });
  const r = run(["revert", p, "#b", "--rev", "-1"]);   // -1 = v1, which had no #b -> remove
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /removed #b \(absent at /);
  assert.ok(!readFileSync(p, "utf8").includes("#b"), "#b removed");
  rmSync(d, { recursive: true, force: true });
});

test("revert --dry-run adds the newline a final-line block lacks", () => {
  const d = mkdtempSync(join(tmpdir(), "geml-cov-rv2-"));
  const p = join(d, "d.geml");
  writeFileSync(p, "=== note {#a}\none\n==="); // no trailing newline
  save({ gemlPath: p, historyPath: join(d, "d.gemlhistory"), summary: "1", at: at("2026-07-03T00:00:00Z") });
  writeFileSync(p, "=== note {#a}\ntwo\n===");
  save({ gemlPath: p, historyPath: join(d, "d.gemlhistory"), summary: "2", at: at("2026-07-04T00:00:00Z") });
  const r = run(["revert", p, "#a", "--dry-run"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /would revert #a/);
  assert.equal(r.out, "=== note {#a}\none\n===\n", "printed block gains the missing final newline");
  assert.equal(readFileSync(p, "utf8"), "=== note {#a}\ntwo\n===", "dry-run writes nothing");
  rmSync(d, { recursive: true, force: true });
});

// --- dispatch edges ---------------------------------------------------------

test("default parse of a broken stdin doc dumps the model and exits 1", () => {
  const r = run(["-"], BAD);
  assert.equal(r.code, 1);
  assert.match(r.out, /"kind": "document"/);
});

test("bare `geml codemap` is a usage error naming the empty subcommand", () => {
  const r = run(["codemap"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown codemap subcommand ''/);
});

test("an unreadable stdin (write-only fd 0) is a clean 'cannot read stdin' error", () => {
  const wOnly = openSync(join(CLI, "sink.txt"), "w");
  try {
    const r = run(["check", "-"], undefined, { stdio: [wOnly, "pipe", "pipe"] });
    assert.equal(r.code, 2);
    assert.match(r.err, /cannot read stdin/);
  } finally {
    closeSync(wOnly);
  }
});

// --- entry detection --------------------------------------------------------

const GEML_URL = pathToFileURL(resolve("dist/geml.js")).href;

test("importing geml.js from `node -e` (no argv[1]) does not trigger the CLI", () => {
  const e = spawnSync(
    process.execPath,
    ["-e", `import(${JSON.stringify(GEML_URL)}).then(()=>console.log("imported"))`],
    { encoding: "utf8", timeout: 60_000 },
  );
  assert.equal(e.status, 0, e.stderr);
  assert.equal((e.stdout ?? "").trim(), "imported", "module loads as a library, CLI stays quiet");
});

test("a deleted argv[1] (realpath fails) falls back to the literal path and stays a library import", () => {
  const runner = join(CLI, "self-deleting-runner.mjs");
  writeFileSync(runner, [
    'import { unlinkSync } from "node:fs";',
    "unlinkSync(process.argv[1]); // argv[1] no longer resolves via realpath",
    `await import(${JSON.stringify(GEML_URL)});`,
    'console.log("loaded-ok");',
  ].join("\n"));
  let r;
  try {
    r = spawnSync(process.execPath, [runner], { encoding: "utf8", timeout: 60_000 });
  } finally {
    try { unlinkSync(runner); } catch { /* already deleted by the child */ }
  }
  assert.equal(r.status, 0, r.stderr);
  assert.equal((r.stdout ?? "").trim(), "loaded-ok");
});

rmSync(CLI, { recursive: true, force: true });
rmSync(HCLI, { recursive: true, force: true });
console.log(`\n${passed} test(s) passed.`);
