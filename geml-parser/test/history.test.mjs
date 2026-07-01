// History tests: the `.gemlhistory` sidecar — commit → verify → show → restore
// round-trip, tamper detection, and the destructive-rollback semantics of
// restore(write:true). Runs in a throwaway temp dir so it never touches the repo.
import { commit, verify, restore } from "../dist/history.js";
import { writeFileSync, readFileSync, rmSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const dir = mkdtempSync(join(tmpdir(), "geml-hist-"));
const geml = join(dir, "doc.geml");
const hist = join(dir, "doc.gemlhistory");
const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const V1 = "=== note {#n}\nRevision ALPHA. See [[#n]].\n===\n";
const V2 = "=== note {#n}\nRevision BETA, edited. See [[#n]].\n===\n";

let id1, id2;

test("commit v1 creates a .gemlhistory sidecar", () => {
  writeFileSync(geml, V1);
  const r = commit({ gemlPath: geml, historyPath: hist, summary: "first", author: "tester", at: new Date("2026-01-01T00:00:00Z") });
  id1 = r.id;
  assert.ok(existsSync(hist), "sidecar written");
  assert.ok(typeof id1 === "string" && id1.length > 0, "returns a revision id");
  assert.ok(r.hash, "returns a content hash");
});

test("commit v2 records a distinct second revision", () => {
  writeFileSync(geml, V2);
  const r = commit({ gemlPath: geml, historyPath: hist, summary: "second", author: "tester", at: new Date("2026-01-02T00:00:00Z") });
  id2 = r.id;
  assert.notEqual(id2, id1, "second revision has its own id");
});

test("verify: an intact history is OK, both revisions reconstructed & hashed", () => {
  const v = verify(hist, geml);
  assert.equal(v.ok, true, v.errors.join("; "));
  assert.equal(v.checked, 2);
  assert.equal(v.errors.length, 0);
});

test("show: restore(write:false) reconstructs each revision byte-for-byte", () => {
  assert.equal(restore({ historyPath: hist, gemlPath: geml, revision: id2 }), V2, "current revision");
  assert.equal(restore({ historyPath: hist, gemlPath: geml, revision: id1 }), V1, "a past revision, exactly");
});

test("tamper: corrupting the history makes verify fail with a hash mismatch", () => {
  const original = readFileSync(hist, "utf8");
  assert.ok(original.includes("BETA"), "the current revision's content is stored");
  writeFileSync(hist, original.replace("BETA", "TAMPERED"));
  const v = verify(hist);
  assert.equal(v.ok, false, "verify rejects the tampered sidecar");
  assert.ok(v.errors.some((e) => /hash/.test(e)), "reports a reconstructed-hash mismatch");
  writeFileSync(hist, original); // put it back for the rollback test
});

test("restore(write:true) rolls the file back and truncates newer revisions", () => {
  restore({ historyPath: hist, gemlPath: geml, revision: id1, write: true, force: true });
  assert.equal(read(geml), V1, "doc.geml reverted to v1");
  const v = verify(hist);
  assert.equal(v.ok, true, v.errors.join("; "));
  assert.equal(v.checked, 1, "rollback is destructive: only v1 remains");
  assert.throws(() => restore({ historyPath: hist, gemlPath: geml, revision: id2 }), /revision/, "v2 is gone");
});

test("restore with an unknown revision selector throws", () => {
  assert.throws(
    () => restore({ historyPath: hist, gemlPath: geml, revision: "definitely-not-a-revision" }),
    /revision/,
  );
});

test("commit without an author still records a verifiable revision", () => {
  const d2 = mkdtempSync(join(tmpdir(), "geml-hist2-"));
  const g = join(d2, "d.geml"), hh = join(d2, "d.gemlhistory");
  writeFileSync(g, "=== note {#n}\nanonymous change\n===\n");
  const r = commit({ gemlPath: g, historyPath: hh, summary: "anon", at: new Date("2026-03-01T00:00:00Z") });
  assert.ok(r.id, "committed without author");
  assert.equal(verify(hh).ok, true);
  rmSync(d2, { recursive: true, force: true });
});

test("verify catches a broken revision chain (dangling parent)", () => {
  const d3 = mkdtempSync(join(tmpdir(), "geml-hist3-"));
  const g = join(d3, "d.geml"), hh = join(d3, "d.gemlhistory");
  writeFileSync(g, "=== note {#n}\none\n===\n");
  commit({ gemlPath: g, historyPath: hh, summary: "1", at: new Date("2026-03-01T00:00:00Z") });
  writeFileSync(g, "=== note {#n}\ntwo\n===\n");
  commit({ gemlPath: g, historyPath: hh, summary: "2", at: new Date("2026-03-02T00:00:00Z") });
  writeFileSync(hh, readFileSync(hh, "utf8").replace(/parent="[^"]+"/, 'parent="does-not-exist"'));
  assert.equal(verify(hh).ok, false, "verify rejects a chain with a dangling parent");
  rmSync(d3, { recursive: true, force: true });
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} test(s) passed.`);
