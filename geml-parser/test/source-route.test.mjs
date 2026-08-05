// `src=` as a ROUTE to content, for the two types whose fragment position is
// free: `code` (a region of a source file) and `data` (a value, optionally a
// line window of a jsonl log). One syntax — `<path>[#L<start>[-<end>]]` — one
// implementation, one set of diagnostics. Spawns the CLI so the resolver, its
// confinement and the exit code are the real ones.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const cli = resolve("dist/geml.js");
const dir = mkdtempSync(join(tmpdir(), "geml-route-"));
const run = (args) => {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
};
const write = (name, text) => { const p = join(dir, name); writeFileSync(p, text); return p; };

write("src.txt", "line1\nline2\nline3\nline4\nline5\n");
write("log.jsonl", '{"a":1}\n{"a":2}\n{"a":3}\n{"a":4}\n');
write("cfg.json", '{\n  "retries": 3\n}\n');

test("code src= loads the named line range into the block", () => {
  const doc = write("a.geml", "=== code {#c lang=text src=src.txt#L2-4}\n===\n");
  assert.equal(run(["check", doc]).code, 0);
  const j = JSON.parse(run([doc, "--to", "json"]).out);
  const b = j.children.find((x) => x.id === "c");
  assert.deepEqual(b.raw, ["line2", "line3", "line4"], "the slice IS the block's content");
});

test("code src= with no fragment takes the whole file", () => {
  const doc = write("b.geml", "=== code {#c src=src.txt}\n===\n");
  assert.equal(run(["check", doc]).code, 0);
  const b = JSON.parse(run([doc, "--to", "json"]).out).children.find((x) => x.id === "c");
  assert.equal(b.raw.length, 5);
});

test("a single-line route is #L<n>", () => {
  const doc = write("c.geml", "=== code {#c src=src.txt#L3}\n===\n");
  const b = JSON.parse(run([doc, "--to", "json"]).out).children.find((x) => x.id === "c");
  assert.deepEqual(b.raw, ["line3"]);
});

test("a range past the end of the file is a stale-range error, not a silent empty block", () => {
  const doc = write("d.geml", "=== code {#c src=src.txt#L4-9}\n===\n");
  const r = run(["check", doc]);
  assert.equal(r.code, 1);
  assert.match(r.out, /the file has 5 line\(s\)/);
  assert.match(r.out, /stale/);
});

test("an unrecognised fragment names the two accepted forms", () => {
  const r = run(["check", write("e.geml", "=== code {#c src=src.txt#top}\n===\n")]);
  assert.equal(r.code, 1);
  assert.match(r.out, /#L<start>/);
});

test("a body alongside src= is a snapshot: a mismatch warns, a match is silent", () => {
  const stale = run(["check", write("f.geml", "=== code {#c src=src.txt#L1}\nSTALE\n===\n")]);
  assert.equal(stale.code, 0, "a stale snapshot is a warning, not a failure");
  assert.match(stale.out, /snapshot/);
  const fresh = run(["check", write("g.geml", "=== code {#c src=src.txt#L1}\nline1\n===\n")]);
  assert.equal(fresh.code, 0);
  assert.doesNotMatch(fresh.out, /snapshot/, "an up-to-date snapshot says nothing");
});

test("an unresolvable code source WARNS (the model survives); a disallowed scheme is refused", () => {
  // A code graph read away from its sources — published on its own, or
  // describing another checkout — stays valid: a code region is still a region
  // at a location. A value that failed to load is the opposite (an error).
  const gone = run(["check", write("h.geml", "=== code {#c src=nope.txt}\n===\n")]);
  assert.equal(gone.code, 0);
  assert.match(gone.out, /cannot resolve code source/);
  const bad = run(["check", write("i.geml", "=== code {#c src=file:///etc/passwd}\n===\n")]);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /disallowed URL scheme/);
});

test("an http(s) code source is left for render time, not reported as broken", () => {
  const r = run(["check", write("j.geml", "=== code {#c src=https://example.com/x.ts#L1-2}\n===\n")]);
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /error/);
});

test("data src= takes the same route syntax: a jsonl window becomes the value", () => {
  const doc = write("k.geml", "=== data {#d format=jsonl src=log.jsonl#L2-3}\n===\n");
  assert.equal(run(["check", doc]).code, 0);
  const b = JSON.parse(run([doc, "--to", "json"]).out).children.find((x) => x.id === "d");
  assert.deepEqual(b.value, [{ a: 2 }, { a: 3 }]);
});

test("a range over a json source is sliced then verified as json — no special rule", () => {
  // Lines 1-3 of cfg.json ARE the whole value, so this is valid …
  const whole = write("l.geml", "=== data {#d src=cfg.json#L1-3}\n===\n");
  assert.equal(run(["check", whole]).code, 0);
  assert.deepEqual(JSON.parse(run([whole, "--to", "json"]).out).children.find((x) => x.id === "d").value, { retries: 3 });
  // … while a slice that is not a value fails with the ordinary parse error.
  const half = run(["check", write("m.geml", "=== data {#d src=cfg.json#L1-2}\n===\n")]);
  assert.equal(half.code, 1);
  assert.match(half.out, /not valid JSON/);
});

test("a source route may be written relative to --root, not only to the document", () => {
  // The code-graph profile writes root-relative routes from a document nested
  // under the graph directory; --root names the tree they live in.
  mkdirSync(join(dir, "graph"), { recursive: true });
  const doc = join(dir, "graph", "n.geml");
  writeFileSync(doc, "=== code {#c src=src.txt#L2}\n===\n");
  assert.match(run(["check", doc]).out, /cannot resolve code source/, "without --root the document-relative path is missing");
  const r = run(["check", "--root", dir, doc]);
  assert.equal(r.code, 0, "with --root the route resolves from that root");
  assert.doesNotMatch(r.out, /cannot resolve/, "and the warning is gone");
  const b = JSON.parse(run([doc, "--root", dir, "--to", "json"]).out).children.find((x) => x.id === "c");
  assert.deepEqual(b.raw, ["line2"]);
});

rmSync(dir, { recursive: true, force: true });
console.log(`source-route: ${passed} passed`);
