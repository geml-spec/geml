// History tests: the `.gemlhistory` change graph — save → verify → get →
// restore, tamper detection, concurrent changes and how they merge, the git
// merge driver, and conversion of a sidecar written in the earlier format.
// Runs in throwaway temp dirs so it never touches the repo.
import { save, verify, restore, merge, mergeDriver, listRevisions, resolveContent, isCurrent, loadHistory } from "../dist/history.js";
import { writeFileSync, readFileSync, rmSync, mkdtempSync, existsSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const here = dirname(fileURLToPath(import.meta.url));
const at = (s) => new Date(Date.UTC(2026, 0, 1, 0, 0, s));
const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const fresh = (name = "doc") => {
  const d = mkdtempSync(join(tmpdir(), "geml-hist-"));
  return { d, g: join(d, `${name}.geml`), h: join(d, `${name}.gemlhistory`) };
};
/** A second copy of a document and its sidecar — another device, another branch. */
const fork = (a) => {
  const b = fresh();
  copyFileSync(a.g, b.g);
  copyFileSync(a.h, b.h);
  return b;
};
const ops = (h) => read(h).split("\n").filter((l) => /^(create|update|remove|move) /.test(l));

const V1 = "=== note {#n}\nRevision ALPHA. See [[#n]].\n===\n";
const V2 = "=== note {#n}\nRevision BETA, edited. See [[#n]].\n===\n";

{
  const { d, g, h } = fresh();
  let id1, id2;

  test("save v1 creates a .gemlhistory sidecar", () => {
    writeFileSync(g, V1);
    const r = save({ gemlPath: g, historyPath: h, summary: "first", author: "tester", at: at(1) });
    id1 = r.id;
    assert.ok(existsSync(h), "sidecar written");
    assert.match(id1, /^20260101T000001Z-[0-9a-f]{12}$/, "id = UTC time + hash");
    assert.ok(r.hash.startsWith("sha256:"), "returns the document's hash");
    assert.match(read(h), /profile += "geml-history\/v1"/, "declares its vocabulary");
  });

  test("save v2 records a second change whose parent is the first", () => {
    writeFileSync(g, V2);
    const r = save({ gemlPath: g, historyPath: h, summary: "second", author: "tester", at: at(2) });
    id2 = r.id;
    assert.notEqual(id2, id1);
    const revs = listRevisions(h);
    assert.deepEqual(revs.map((x) => x.id), [id2, id1], "latest first");
    assert.deepEqual(revs[0].parents, [id1]);
    assert.equal(revs[0].current, true);
  });

  test("saving an unchanged file records nothing and returns the head", () => {
    const before = read(h);
    assert.equal(save({ gemlPath: g, historyPath: h, summary: "again", at: at(3) }).id, id2);
    assert.equal(read(h), before);
    assert.equal(isCurrent(h, g), true);
  });

  test("verify: an intact history is OK, both changes replayed & hashed", () => {
    const v = verify(h, g);
    assert.equal(v.ok, true, v.errors.join("; "));
    assert.equal(v.checked, 2);
    assert.deepEqual(v.warnings, []);
  });

  test("restore(write:false) reconstructs each change byte-for-byte", () => {
    assert.equal(restore({ historyPath: h, gemlPath: g, revision: id2 }), V2);
    assert.equal(restore({ historyPath: h, gemlPath: g, revision: id1 }), V1);
    assert.equal(restore({ historyPath: h, gemlPath: g, revision: "-1" }), V1, "-N counts back");
  });

  test("tamper: altered content fails verify", () => {
    const original = readFileSync(h, "utf8");
    writeFileSync(h, original.replace(/BETA/g, "TAMPERED"));
    const v = verify(h);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => /does not match/.test(e)), v.errors.join("; "));
    writeFileSync(h, original);
  });

  test("tamper: an edited summary changes nothing but the id no longer matches", () => {
    const original = readFileSync(h, "utf8");
    writeFileSync(h, original.replace('summary="first"', 'summary="forged"'));
    const v = verify(h);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes(id1) && /id does not match/.test(e)), v.errors.join("; "));
    writeFileSync(h, original);
  });

  test("restore(write:true) writes the old document and records it as a NEW change", () => {
    restore({ historyPath: h, gemlPath: g, revision: id1, write: true, at: at(4) });
    assert.equal(read(g), V1);
    const revs = listRevisions(h);
    assert.equal(revs.length, 3, "nothing is discarded");
    assert.match(revs[0].summary, new RegExp(`restore to ${id1}`));
    assert.equal(resolveContent(h, id2).text, V2, "the change restored away from is still there");
    assert.equal(verify(h, g).ok, true);
  });

  test("restore refuses to discard unsaved edits without force", () => {
    writeFileSync(g, V1 + "\nunsaved\n");
    assert.throws(() => restore({ historyPath: h, gemlPath: g, revision: id2, write: true }), /uncommitted/);
    restore({ historyPath: h, gemlPath: g, revision: id2, write: true, force: true, at: at(5) });
    assert.equal(read(g), V2);
  });

  test("an unknown selector throws", () => {
    assert.throws(() => restore({ historyPath: h, gemlPath: g, revision: "definitely-not-a-change" }), /matched 0/);
  });
  rmSync(d, { recursive: true, force: true });
}

test("verify catches a dangling parent", () => {
  const { d, g, h } = fresh();
  writeFileSync(g, "=== note {#n}\none\n===\n");
  save({ gemlPath: g, historyPath: h, summary: "1", at: at(1) });
  writeFileSync(g, "=== note {#n}\ntwo\n===\n");
  save({ gemlPath: g, historyPath: h, summary: "2", at: at(2) });
  writeFileSync(h, readFileSync(h, "utf8").replace(/parents="[^"]+"/, 'parents="does-not-exist"'));
  const v = verify(h);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /parent does-not-exist is missing/.test(e)), v.errors.join("; "));
  rmSync(d, { recursive: true, force: true });
});

test("a paragraph edited in place keeps its key: one update, no remove/create", () => {
  const { d, g, h } = fresh();
  writeFileSync(g, "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n");
  save({ gemlPath: g, historyPath: h, summary: "1", at: at(1) });
  const created = ops(h);
  writeFileSync(g, "# Title\n\nFirst paragraph, edited.\n\nSecond paragraph.\n");
  save({ gemlPath: g, historyPath: h, summary: "2", at: at(2) });
  const latest = ops(h).filter((l) => !created.includes(l));
  assert.equal(latest.length, 1, latest.join("\n"));
  assert.match(latest[0], /^update ~[0-9a-f]{8} <- blob:b-[0-9a-f]{12}$/);
  rmSync(d, { recursive: true, force: true });
});

test("a block moved without edits is recorded as a move", () => {
  const { d, g, h } = fresh();
  // Every unit owns exactly one blank line (the separator, or the final newline),
  // so reordering moves blocks without moving whitespace between them.
  const A = "=== note {#a}\nA\n===\n", B = "=== note {#b}\nB\n===\n", C = "Plain C.\n";
  writeFileSync(g, [A, B, C].join("\n"));
  save({ gemlPath: g, historyPath: h, summary: "1", at: at(1) });
  const before = ops(h);
  writeFileSync(g, [C, A, B].join("\n"));
  save({ gemlPath: g, historyPath: h, summary: "2", at: at(2) });
  const latest = ops(h).filter((l) => !before.includes(l));
  assert.deepEqual(latest.map((l) => l.split(" ")[0]), ["move"], latest.join("\n"));
  assert.equal(verify(h, g).ok, true);
  rmSync(d, { recursive: true, force: true });
});

test("a removed block that comes back with its id is resurrected, not duplicated", () => {
  const { d, g, h } = fresh();
  const doc = (mid) => `=== note {#a}\nA\n===\n\n${mid}=== note {#c}\nC\n===\n`;
  writeFileSync(g, doc("=== note {#b}\nB\n===\n\n"));
  save({ gemlPath: g, historyPath: h, summary: "1", at: at(1) });
  writeFileSync(g, doc(""));
  save({ gemlPath: g, historyPath: h, summary: "2", at: at(2) });
  writeFileSync(g, doc("=== note {#b}\nB again\n===\n\n"));
  save({ gemlPath: g, historyPath: h, summary: "3", at: at(3) });
  assert.equal(ops(h).filter((l) => l.startsWith("create #b ")).length, 2, "the original create and the resurrecting one");
  assert.equal(verify(h, g).ok, true);
  rmSync(d, { recursive: true, force: true });
});

test("reconstruct is byte-exact across several changes", () => {
  const { d, g, h } = fresh();
  const doc = (n) => `=== note {#n}\n${n}\n===\n\n=== note {#k}\nkeep\n===\n`;
  const ids = ["one", "two", "three"].map((v, i) => { writeFileSync(g, doc(v)); return save({ gemlPath: g, historyPath: h, summary: v, at: at(i) }).id; });
  ["one", "two", "three"].forEach((v, i) => assert.equal(resolveContent(h, ids[i]).text, doc(v)));
  assert.equal(verify(h).checked, 3);
  rmSync(d, { recursive: true, force: true });
});

test("large document (3,000 blocks): saves, round-trips, verifies", () => {
  const { d, g, h } = fresh("big");
  const block = (i, body) => `=== note {#n${i}}\n${body}\n===\n`;
  const docOf = (v) => Array.from({ length: 3000 }, (_, i) => block(i, i === 1500 ? v : `body ${i}`)).join("\n");
  writeFileSync(g, docOf("one"));
  const a = save({ gemlPath: g, historyPath: h, summary: "v1", at: at(1) }).id;
  writeFileSync(g, docOf("two"));
  save({ gemlPath: g, historyPath: h, summary: "v2", at: at(2) });
  assert.equal(resolveContent(h, a).text, docOf("one"));
  assert.equal(ops(h).filter((l) => l.startsWith("update")).length, 1, "one block changed, one update");
  assert.equal(verify(h).ok, true);
  rmSync(d, { recursive: true, force: true });
});

test("a document that repeats an id still saves and round-trips", () => {
  const { d, g, h } = fresh();
  const docOf = (v) => `=== note {#dup}\nfirst ${v}\n===\n\n=== note {#dup}\nsecond\n===\n\n=== note {#ok}\ntail\n===\n`;
  writeFileSync(g, docOf("one"));
  const a = save({ gemlPath: g, historyPath: h, summary: "v1", at: at(1) }).id;
  writeFileSync(g, docOf("two"));
  save({ gemlPath: g, historyPath: h, summary: "v2", at: at(2) });
  assert.equal(resolveContent(h, a).text, docOf("one"));
  assert.equal(verify(h).ok, true);
  rmSync(d, { recursive: true, force: true });
});

test("two identical paragraphs added in one save", () => {
  const { d, g, h } = fresh();
  const base = "=== note {#x}\nkeep\n===\n";
  writeFileSync(g, base);
  const a = save({ gemlPath: g, historyPath: h, summary: "v1", at: at(1) }).id;
  writeFileSync(g, "same para\n\nsame para\n\n" + base);
  const b = save({ gemlPath: g, historyPath: h, summary: "v2", at: at(2) }).id;
  assert.equal(resolveContent(h, a).text, base);
  assert.equal(resolveContent(h, b).text, "same para\n\nsame para\n\n" + base);
  assert.equal(verify(h, g).ok, true);
  rmSync(d, { recursive: true, force: true });
});

test("a newline flip between saves: every change still verifies", () => {
  const { d, g, h } = fresh();
  writeFileSync(g, V1);
  const a = save({ gemlPath: g, historyPath: h, summary: "lf", at: at(1) }).id;
  writeFileSync(g, V2.replace(/\n/g, "\r\n"));
  save({ gemlPath: g, historyPath: h, summary: "crlf", at: at(2) });
  const v = verify(h, g);
  assert.equal(v.ok, true, v.errors.join("; "));
  assert.equal(resolveContent(h, a).text, V1);
  assert.match(readFileSync(h, "utf8"), /newline=crlf/);
  rmSync(d, { recursive: true, force: true });
});

test("verify with unsaved edits warns and still checks every change", () => {
  const { d, g, h } = fresh();
  writeFileSync(g, "=== note {#a}\none\n===\n");
  save({ gemlPath: g, historyPath: h, summary: "1", at: at(1) });
  writeFileSync(g, "=== note {#a}\ntwo\n===\n");
  save({ gemlPath: g, historyPath: h, summary: "2", at: at(2) });
  writeFileSync(g, read(g) + "\nlocal edit not saved\n");
  const v = verify(h, g);
  assert.equal(v.ok, true, v.errors.join("; "));
  assert.equal(v.checked, 2);
  assert.ok(v.warnings.some((w) => /uncommitted changes/.test(w)));
  rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Concurrent changes
// ---------------------------------------------------------------------------

const BASE = "# Title\n\nPara one.\n\nPara two.\n\n=== note {#risks}\nRisk A.\n===\n";

function twoCopies() {
  const a = fresh();
  writeFileSync(a.g, BASE);
  save({ gemlPath: a.g, historyPath: a.h, summary: "base", at: at(1) });
  return [a, fork(a)];
}

test("edits to different blocks on two copies both survive the merge, with no warning", () => {
  const [a, b] = twoCopies();
  writeFileSync(a.g, BASE.replace("Para two.", "Para two by A."));
  save({ gemlPath: a.g, historyPath: a.h, summary: "A", author: "alice", at: at(2) });
  writeFileSync(b.g, BASE.replace("Risk A.", "Risk B.") + "\nNew para by B.\n");
  save({ gemlPath: b.g, historyPath: b.h, summary: "B", author: "bob", at: at(3) });
  const r = merge({ historyPath: a.h, otherPath: b.h, gemlPath: a.g, at: at(4) });
  assert.equal(r.added, 1);
  assert.ok(r.id, "a merge change joins the two heads");
  assert.deepEqual(r.lost, []);
  assert.equal(read(a.g), BASE.replace("Para two.", "Para two by A.").replace("Risk A.", "Risk B.") + "\nNew para by B.\n");
  const v = verify(a.h, a.g);
  assert.equal(v.ok, true, v.errors.join("; "));
  assert.deepEqual(v.warnings, []);
  assert.deepEqual(listRevisions(a.h)[0].parents.length, 2);
});

test("the same block edited on both copies: the later change wins, the other is named", () => {
  const [a, b] = twoCopies();
  writeFileSync(a.g, BASE.replace("Para one.", "Para one, A."));
  const ida = save({ gemlPath: a.g, historyPath: a.h, summary: "A", author: "alice", at: at(5) }).id;
  writeFileSync(b.g, BASE.replace("Para one.", "Para one, B."));
  const idb = save({ gemlPath: b.g, historyPath: b.h, summary: "B", author: "anytype", at: at(6) }).id;
  const r = merge({ historyPath: a.h, otherPath: b.h, gemlPath: a.g, at: at(7) });
  assert.match(read(a.g), /Para one, B\./, "B is later");
  assert.equal(r.lost.length, 1);
  assert.ok(r.lost[0].includes(`kept ${idb} (anytype)`) && r.lost[0].includes(`superseded ${ida} (alice)`), r.lost[0]);
  assert.equal(resolveContent(a.h, ida).text, BASE.replace("Para one.", "Para one, A."), "the losing edit is still in the history");
  assert.equal(verify(a.h, a.g).ok, true);
});

test("the merge result does not depend on which copy merges which", () => {
  const [a, b] = twoCopies();
  writeFileSync(a.g, BASE.replace("Para one.", "Para one, A.").replace("Risk A.", "Risk A2."));
  save({ gemlPath: a.g, historyPath: a.h, summary: "A", at: at(5) });
  writeFileSync(b.g, BASE.replace("Para one.", "Para one, B.") + "\nTail.\n");
  save({ gemlPath: b.g, historyPath: b.h, summary: "B", at: at(6) });
  const a2 = fork(a), b2 = fork(b);
  merge({ historyPath: a.h, otherPath: b.h, gemlPath: a.g, at: at(9) });
  merge({ historyPath: b2.h, otherPath: a2.h, gemlPath: b2.g, at: at(9) });
  assert.equal(read(a.g), read(b2.g));
  assert.equal(listRevisions(a.h)[0].id, listRevisions(b2.h)[0].id, "the same merge change, the same id");
});

test("an edit to a block the other copy removed: the removal wins, the edit is named", () => {
  const [a, b] = twoCopies();
  writeFileSync(a.g, BASE.replace("Risk A.", "Risk A, edited."));
  save({ gemlPath: a.g, historyPath: a.h, summary: "edit", at: at(5) });
  writeFileSync(b.g, BASE.replace("\n=== note {#risks}\nRisk A.\n===\n", ""));
  save({ gemlPath: b.g, historyPath: b.h, summary: "remove", at: at(6) });
  const r = merge({ historyPath: a.h, otherPath: b.h, gemlPath: a.g, at: at(7) });
  assert.doesNotMatch(read(a.g), /Risk/);
  assert.equal(r.lost.length, 1);
  assert.match(r.lost[0], /#risks was removed/);
});

test("two copies appending after the same block: both kept, and they stay separate paragraphs", () => {
  const [a, b] = twoCopies();
  writeFileSync(a.g, BASE + "\nFrom A.");
  save({ gemlPath: a.g, historyPath: a.h, summary: "A", at: at(5) });
  writeFileSync(b.g, BASE + "\nFrom B.");
  save({ gemlPath: b.g, historyPath: b.h, summary: "B", at: at(6) });
  merge({ historyPath: a.h, otherPath: b.h, gemlPath: a.g, at: at(7) });
  const text = read(a.g);
  assert.match(text, /From B\.\n\nFrom A\./, "the later insert sits next to the anchor, and a blank line keeps them apart");
  assert.equal(verify(a.h, a.g).ok, true);
  // A save on top of the merged state replays identically from the start.
  writeFileSync(a.g, text.replace("From A.", "From A, later."));
  save({ gemlPath: a.g, historyPath: a.h, summary: "after", at: at(8) });
  assert.equal(verify(a.h, a.g).ok, true, verify(a.h, a.g).errors.join("; "));
});

test("merge refuses to overwrite unsaved edits, unless forced", () => {
  const [a, b] = twoCopies();
  writeFileSync(b.g, BASE + "\nB.\n");
  save({ gemlPath: b.g, historyPath: b.h, summary: "B", at: at(5) });
  writeFileSync(a.g, BASE + "\nunsaved\n");
  assert.throws(() => merge({ historyPath: a.h, otherPath: b.h, gemlPath: a.g }), /uncommitted/);
  merge({ historyPath: a.h, otherPath: b.h, gemlPath: a.g, force: true, at: at(6) });
  assert.match(read(a.g), /\nB\.\n/);
});

test("merging a copy into itself, or one it already contains, adds nothing", () => {
  const [a, b] = twoCopies();
  const before = read(a.h);
  const r = merge({ historyPath: a.h, otherPath: b.h, gemlPath: a.g, at: at(5) });
  assert.equal(r.added, 0);
  assert.equal(r.id, undefined);
  assert.equal(read(a.h), before);
});

test("git merge driver: ours ∪ theirs in place, heads joined, the live file untouched", () => {
  const [a, b] = twoCopies();
  writeFileSync(a.g, BASE.replace("Para two.", "Two, A."));
  save({ gemlPath: a.g, historyPath: a.h, summary: "A", at: at(5) });
  writeFileSync(b.g, BASE.replace("Risk A.", "Risk, B."));
  save({ gemlPath: b.g, historyPath: b.h, summary: "B", at: at(6) });
  const liveBefore = read(a.g);
  mergeDriver(a.h, b.h, at(7));
  assert.equal(read(a.g), liveBefore, "git merges the .geml itself");
  assert.equal(listRevisions(a.h)[0].parents.length, 2);
  // Here the live file is what git would have produced; saving it records nothing new.
  writeFileSync(a.g, BASE.replace("Para two.", "Two, A.").replace("Risk A.", "Risk, B."));
  const v = verify(a.h, a.g);
  assert.equal(v.ok, true, v.errors.join("; "));
  assert.deepEqual(v.warnings, []);
});

test("a hand-made union with two heads: reads, warns, and the next save joins them", () => {
  const [a, b] = twoCopies();
  writeFileSync(a.g, BASE.replace("Para two.", "Two, A."));
  save({ gemlPath: a.g, historyPath: a.h, summary: "A", at: at(5) });
  writeFileSync(b.g, BASE.replace("Risk A.", "Risk, B."));
  save({ gemlPath: b.g, historyPath: b.h, summary: "B", at: at(6) });
  // Append B's newest change block (and its blobs) to A by hand.
  const tail = read(b.h).split("\n=== history-change ")[1];
  writeFileSync(a.h, read(a.h) + "\n=== history-change " + tail.split("\n=== history-change ")[0]);
  const v = verify(a.h);
  assert.equal(v.ok, true, v.errors.join("; "));
  assert.ok(v.warnings.some((w) => /2 heads/.test(w)));
  assert.equal(isCurrent(a.h, a.g), false);
  assert.throws(() => resolveContent(a.h, "0"), /2 heads/);
  writeFileSync(a.g, BASE.replace("Para two.", "Two, A.").replace("Risk A.", "Risk, B."));
  save({ gemlPath: a.g, historyPath: a.h, summary: "join", at: at(8) });
  assert.equal(listRevisions(a.h)[0].parents.length, 2);
  assert.equal(verify(a.h, a.g).ok, true);
});

// ---------------------------------------------------------------------------
// The earlier sidecar format
// ---------------------------------------------------------------------------

test("an earlier-format sidecar is read, and rewritten as a change graph on the next save", () => {
  const { d, g, h } = fresh();
  copyFileSync(join(here, "fixtures", "legacy.gemlhistory"), h);
  const texts = [
    "# Plan\n\nIntro text.\n\n=== note {#n}\nalpha\n===\n",
    "# Plan\n\nIntro text, revised.\n\n=== note {#n}\nalpha\n===\n",
    "# Plan\n\nIntro text, revised.\n\n=== note {#n}\nbeta\n===\n\nClosing line.\n",
  ];
  writeFileSync(g, texts[2]);
  const v = verify(h, g);
  assert.equal(v.ok, true, v.errors.join("; "));
  assert.ok(v.warnings.some((w) => /earlier format/.test(w)));
  assert.equal(listRevisions(h).length, 3);
  assert.equal(resolveContent(h, "20260101T000000Z-7bc51eb4").text, texts[0], "an old id still selects its change");
  assert.equal(resolveContent(h, "7bc51eb4").text, texts[0]);
  assert.equal(isCurrent(h, g), true);
  writeFileSync(g, texts[2] + "\nMore.\n");
  save({ gemlPath: g, historyPath: h, summary: "after conversion", at: at(9) });
  assert.doesNotMatch(read(h), /history-revision|history-keyframe/);
  assert.match(read(h), /was="20260102T000000Z-b2911159"/);
  assert.equal(verify(h, g).ok, true);
  assert.equal(loadHistory(h).changes.size, 4);
  rmSync(d, { recursive: true, force: true });
});

test("a file that is not a sidecar is refused, never overwritten", () => {
  const { d, g, h } = fresh();
  writeFileSync(g, V1);
  writeFileSync(h, "total garbage, not a history file\n");
  assert.throws(() => save({ gemlPath: g, historyPath: h, summary: "x" }), /records no changes/);
  assert.equal(read(h), "total garbage, not a history file\n");
  assert.equal(verify(h, g).ok, false);
  rmSync(d, { recursive: true, force: true });
});

test("an earlier-format sidecar that does not reproduce its hashes is not converted", () => {
  const { d, g, h } = fresh();
  const src = readFileSync(join(here, "fixtures", "legacy.gemlhistory"), "utf8");
  writeFileSync(h, src.replace("Intro text.", "Intro text, altered."));
  writeFileSync(g, "x\n");
  const v = verify(h, g);
  assert.equal(v.ok, false);
  assert.match(v.errors[0], /does not reproduce its recorded hash/);
  writeFileSync(h, src.replace(/parent="20260101T000000Z-7bc51eb4"/, 'parent="missing"'));
  assert.match(verify(h, g).errors[0], /missing \(broken chain\)/);
  rmSync(d, { recursive: true, force: true });
});

test("converting the same earlier-format sidecar twice gives the same ids", () => {
  const x = loadHistory(join(here, "fixtures", "legacy.gemlhistory"));
  const y = loadHistory(join(here, "fixtures", "legacy.gemlhistory"));
  assert.deepEqual([...x.changes.keys()], [...y.changes.keys()]);
});

console.log(`\n${passed} test(s) passed.`);
