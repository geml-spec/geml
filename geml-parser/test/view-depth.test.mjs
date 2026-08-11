// Two refusals that had no test, both of them the kind that must not be quiet.
//
// `--view` reads THROUGH an embed to the entity block it stands for. A chain
// that never arrives is the dangerous case: the renderer is allowed to give up
// silently — a nine-deep chain is legal and simply is not expanded — but
// `--view` may not, because stopping means what it is holding is still a FRAME,
// and handing that back would answer the question wrongly rather than not at
// all.
//
// And `--from json`, which is how a tool feeds an edited document model back in:
// invalid JSON has to name the file and the parser's own complaint, or the
// caller is left guessing which of the two sides is malformed.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "geml.js");
let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }
const cli = (dir, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", timeout: 60_000 });

test("--view follows a chain of frames to the entity block at its end", () => {
  // Three hops, well inside the cap: the answer is the note, not any frame.
  const dir = mkdtempSync(join(tmpdir(), "geml-view-ok-"));
  writeFileSync(join(dir, "c.geml"), "=== note {#target}\nthe real content\n===\n");
  writeFileSync(join(dir, "b.geml"), "=== embed {#mid src=c.geml#target}\n===\n");
  writeFileSync(join(dir, "a.geml"), "=== embed {#start src=b.geml#mid}\n===\n");
  const r = cli(dir, "get", "a.geml", "#start", "--view");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /the real content/);
  assert.match(r.stderr, /view:/, "provenance is reported on stderr");
  rmSync(dir, { recursive: true, force: true });
});

test("a chain still not on an entity block at the cap is an error, never a frame", () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-view-deep-"));
  // Twelve frames pointing at the next, past any cap, and the last one at a
  // note — so the ONLY reason to stop early is the cap itself.
  for (let i = 0; i < 12; i++) {
    writeFileSync(join(dir, `f${i}.geml`), `=== embed {#f${i} src=f${i + 1}.geml#f${i + 1}}\n===\n`);
  }
  writeFileSync(join(dir, "f12.geml"), "=== note {#f12}\nthe end\n===\n");
  const r = cli(dir, "get", "f0.geml", "#f0", "--view");
  assert.equal(r.status, 1, "a chain that does not arrive is a failed read");
  assert.match(r.stderr, /depth|hops/i, "and it says the cap is why");
  assert.doesNotMatch(r.stdout, /=== embed/, "no frame is handed back as if it were the answer");
  rmSync(dir, { recursive: true, force: true });
});

test("--from json names the file and the reason when the JSON will not parse", () => {
  const dir = mkdtempSync(join(tmpdir(), "geml-badjson-"));
  const f = join(dir, "broken.json");
  writeFileSync(f, '{"kind":"document","children":[');
  const r = cli(dir, "broken.json", "--from", "json", "--to", "geml");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not valid JSON/);
  assert.match(r.stderr, /broken\.json/, "the file is named, not just 'input'");
  rmSync(dir, { recursive: true, force: true });
});

test("--from json on stdin says stdin rather than naming no file at all", () => {
  const r = spawnSync(process.execPath, [CLI, "-", "--from", "json", "--to", "geml"], {
    input: "{not json", encoding: "utf8", timeout: 60_000,
  });
  assert.equal(r.status ?? 1, 1);
  assert.match(r.stderr, /not valid JSON/);
  assert.match(r.stderr, /stdin/);
});

console.log(`view-depth: ${passed} passed`);
