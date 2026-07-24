// The unified `geml <file> --to <fmt>` transform entry: one door for the four
// conversions that used to be render/export/fmt/convert/bare-parse. Also pins
// input-format resolution (--from > extension > geml), the per-input --to
// defaults, and that the recycled keywords now fall through to unknown-command.
// Spawns the built CLI like cli.test.mjs.
import { spawnSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

function run(args, input) {
  const r = spawnSync(process.execPath, ["dist/geml.js", ...args], { input, encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const GOOD = "=== note {#n}\nok, see [[#n]]\n===\n";
const BAD = "=== code {#c}\nunterminated, no closing fence\n"; // missing ===
const MD = "# Title\n\nbody text\n";
const dir = mkdtempSync(join(tmpdir(), "geml-to-"));
const p = (name) => join(dir, name);

// -- the four output targets from a GEML input ------------------------------

test("--to json is the default for a GEML input, byte-equal to bare parse", () => {
  const bare = run(["-"], GOOD);
  const explicit = run(["-", "--to", "json"], GOOD);
  assert.equal(bare.code, 0, bare.err);
  assert.equal(explicit.code, 0, explicit.err);
  assert.equal(explicit.out, bare.out, "--to json output must equal bare parse");
  assert.match(explicit.out, /"kind": "document"/);
});

test("--to geml re-serializes to canonical GEML (the old `fmt`)", () => {
  const r = run(["-", "--to", "geml"], GOOD);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /=== note/);
});

test("--to html renders one self-contained HTML document (the old `render`)", () => {
  const r = run(["-", "--to", "html"], GOOD);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /<html|<!doctype/i);
});

test("--to md projects to Markdown (the old `export`)", () => {
  const r = run(["-", "--to", "md"], "# H\n\n=== code {lang=js}\nx=1\n===\n");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^# H/m);
  assert.match(r.out, /```js\nx=1\n```/);
});

// -- input-format resolution: --from > extension > geml ---------------------

test("a .md file converts the OTHER way and defaults to --to geml", () => {
  const f = p("notes.md"); writeFileSync(f, MD);
  const r = run([f]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^# Title/m);
  assert.doesNotMatch(r.out, /"kind": "document"/, "md input default is GEML, not JSON");
});

test("a .md file with --to json parses through to the document model", () => {
  const f = p("notes-json.md"); writeFileSync(f, MD);
  const r = run([f, "--to", "json"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /"kind": "document"/);
});

test("a .md file with --to html renders HTML", () => {
  const f = p("notes-html.md"); writeFileSync(f, MD);
  const r = run([f, "--to", "html"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /<html|<!doctype/i);
});

test("--from md treats a non-.md file as Markdown", () => {
  const f = p("notes.txt"); writeFileSync(f, MD);
  const r = run([f, "--from", "md"]); // md input -> default --to geml
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^# Title/m);
  assert.doesNotMatch(r.out, /"kind": "document"/);
});

test("--from md on stdin reads Markdown from '-' (stdin is GEML otherwise)", () => {
  const r = run(["-", "--from", "md", "--to", "geml"], MD);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^# Title/m);
});

test("stdin without --from is treated as GEML (default --to json)", () => {
  const r = run(["-"], GOOD);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /"kind": "document"/);
});

// -- -o writes to a path; diagnostics + exit codes --------------------------

test("-o writes the transform output to a file and notes the path on stderr", () => {
  const src = p("d.geml"); writeFileSync(src, GOOD);
  const outHtml = p("d.html");
  const r = run([src, "--to", "html", "-o", outHtml]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /wrote /);
  assert.ok(existsSync(outHtml));
  assert.match(readFileSync(outHtml, "utf8"), /<html|<!doctype/i);
});

test("a broken doc exits 1 for every GEML-input target", () => {
  for (const to of ["json", "geml", "html", "md"]) {
    const r = run(["-", "--to", to], BAD);
    assert.equal(r.code, 1, `--to ${to} on a broken doc must exit 1 (got ${r.code}: ${r.err})`);
  }
});

test("an unknown --to value is a usage error (exit 2)", () => {
  const r = run(["-", "--to", "pdf"], GOOD);
  assert.equal(r.code, 2);
  assert.match(r.err, /--to/);
});

test("an unknown --from value is a usage error (exit 2)", () => {
  const r = run(["-", "--from", "rst"], GOOD);
  assert.equal(r.code, 2);
  assert.match(r.err, /--from/);
});

// -- recycled keywords now fall through to unknown-command ------------------

test("render / export / fmt / convert are no longer commands (unknown, exit 2)", () => {
  for (const kw of ["render", "export", "fmt", "convert"]) {
    const r = run([kw, "-"], GOOD);
    assert.equal(r.code, 2, `${kw} should be an unknown command (got exit ${r.code})`);
    assert.match(r.err, new RegExp(`unknown command '${kw}'`));
  }
});

test("recycled keywords do not appear as commands in --help", () => {
  const h = run(["--help"]);
  assert.equal(h.code, 0);
  assert.doesNotMatch(h.out, /geml (render|export|convert|fmt) /, "recycled verbs must be gone from USAGE");
});

console.log(`\n${passed} test(s) passed.`);
process.exit(0);
