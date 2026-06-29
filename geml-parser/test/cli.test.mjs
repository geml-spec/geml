// End-to-end CLI tests: spawn `node dist/geml.js` and assert exit codes,
// stdout/stderr, and the agent-friendly behaviours (clean errors, stdin,
// `check`, `--help`/`--version`). These are the contract an agent relies on.
import { spawnSync } from "node:child_process";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

// Run the CLI; capture code/stdout/stderr regardless of exit code. (spawnSync,
// not execFileSync — the latter discards stderr on a zero exit.)
function run(args, input) {
  const r = spawnSync(process.execPath, ["dist/geml.js", ...args], { input, encoding: "utf8" });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const GOOD = "=== note {#n}\nok, see [[#n]]\n===\n";
const BAD = "=== code {#c}\nunterminated, no closing fence\n"; // missing ===

test("--help exits 0 and lists the commands", () => {
  const r = run(["--help"]);
  assert.equal(r.code, 0);
  for (const c of ["check", "render", "convert", "fmt", "history"]) assert.match(r.out, new RegExp(c));
});

test("--version exits 0 and prints a version", () => {
  const r = run(["--version"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /\d/);
});

test("no args is a usage error (exit 2) printing usage to stderr", () => {
  const r = run([]);
  assert.equal(r.code, 2);
  assert.match(r.err, /Usage:/);
});

test("unknown command exits 2 with a clean message, no stack trace", () => {
  const r = run(["chekc"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown command 'chekc'/);
  assert.doesNotMatch(r.err, /node:/);
});

test("missing file exits non-zero with a clean message, no stack trace", () => {
  const r = run(["nope.geml"]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /cannot read nope\.geml/);
  assert.doesNotMatch(r.err, /node:fs|at Object|ENOENT/);
});

test("default parse reads stdin via '-' and emits the document model", () => {
  const r = run(["-"], GOOD);
  assert.equal(r.code, 0);
  assert.match(r.out, /"kind": "document"/);
});

test("check on a clean doc exits 0 and does NOT dump the document model", () => {
  const r = run(["check", "-"], GOOD);
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /"kind": "document"/);
  assert.match(r.err, /ok: no diagnostics/);
});

test("check on a broken doc exits 1 with a diagnostic", () => {
  const r = run(["check", "-"], BAD);
  assert.equal(r.code, 1);
  assert.match(r.err, /error/);
});

test("check --json prints the diagnostics array to stdout", () => {
  const r = run(["check", "--json", "-"], BAD);
  assert.equal(r.code, 1);
  assert.match(r.out, /"severity"/);
});

test("fmt on a broken doc exits non-zero (no silent success)", () => {
  const r = run(["fmt", "-"], BAD);
  assert.equal(r.code, 1);
  assert.match(r.err, /error/);
});

test("fmt on a clean doc exits 0 and round-trips through stdin", () => {
  const r = run(["fmt", "-"], GOOD);
  assert.equal(r.code, 0);
  assert.match(r.out, /=== note/);
});

test("history on a missing sidecar exits non-zero, no stack trace or abs path", () => {
  const r = run(["history", "verify", "definitely-not-here.geml"]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /cannot read history definitely-not-here\.gemlhistory/);
  assert.doesNotMatch(r.err, /node:fs|at Object|ENOENT|[A-Za-z]:\\/);
});

test("history with an unknown subcommand exits 2 with a clean message", () => {
  const r = run(["history", "frobnicate", "x.geml"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown history subcommand: frobnicate/);
  assert.doesNotMatch(r.err, /node:/);
});

console.log(`\n${passed} test(s) passed.`);
