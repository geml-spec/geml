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
  for (const c of ["check", "render", "convert", "fmt", "history", "codemap"]) assert.match(r.out, new RegExp(c));
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

test("a subcommand --help is a help request: usage to stdout, exit 0", () => {
  const r = run(["check", "--help"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /usage: geml check/);
  assert.doesNotMatch(r.err, /error:/);
});

test("--json turns an IO error into a parseable envelope", () => {
  const r = run(["check", "--json", "nope.geml"]);
  assert.notEqual(r.code, 0);
  const env = JSON.parse(r.err.trim());
  assert.equal(env.error, "cannot read nope.geml");
  assert.equal(env.code, 2);
});

test("--json turns an unknown command into a parseable envelope", () => {
  const r = run(["chekc", "--json"]);
  assert.equal(r.code, 2);
  const env = JSON.parse(r.err.trim());
  assert.match(env.error, /unknown command 'chekc'/);
});

test("--version --json prints a parseable {parser, spec} object", () => {
  const r = run(["--version", "--json"]);
  assert.equal(r.code, 0);
  const v = JSON.parse(r.out.trim());
  assert.ok(v.parser && v.spec, "has parser and spec fields");
});

test("export emits Markdown from stdin and exits 0 on a clean doc", () => {
  const r = run(["export", "-"], "# H\n\n=== code {lang=js}\nx=1\n===\n");
  assert.equal(r.code, 0);
  assert.match(r.out, /^# H/m);
  assert.match(r.out, /```js\nx=1\n```/);
});

test("export exits non-zero on a broken doc (same signal as render)", () => {
  const r = run(["export", "-"], "=== code {#c}\nunterminated\n");
  assert.equal(r.code, 1);
  assert.match(r.err, /error/);
});

// ---------------------------------------------------------------------------
// geml codemap — the code-graph toolkit dispatch (build/verify/render/serve)
// ---------------------------------------------------------------------------

// A minimal two-document codemap on disk (same shape the emitter writes).
import { mkdtempSync, writeFileSync as wf, readFileSync as rf, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
const CODEMAP_DIR = mkdtempSync(pjoin(tmpdir(), "geml-codemap-"));
wf(pjoin(CODEMAP_DIR, "auth.geml"),
  "=== meta\nmodule = auth\nentry = #login\nresolution-default = cpg\n===\n\n" +
  '=== code {#login src=src/login.ts#L1-9 anchor="a1"}\n===\n' +
  '=== code {#issueToken .leaf src=src/token.ts#L1-5 anchor="a2"}\n===\n\n' +
  "=== table {#calls format=csv}\nfrom, to, kind, confidence\n#login, #issueToken, call,\n===\n");
wf(pjoin(CODEMAP_DIR, "index.geml"),
  "=== meta\nrepo = demo\ncontainer = module\nresolution-default = cpg\n===\n\n" +
  "=== table {#modules format=csv}\nmodule, doc, methods, entries, tests\nauth, auth.geml, 2, 1, 0\n===\n\n" +
  "=== table {#module-edges format=csv}\nfrom, to, calls\n===\n");

test("codemap --help exits 0; unknown subcommand exits 2 with the usage", () => {
  const h = run(["codemap", "--help"]);
  assert.equal(h.code, 0);
  for (const s of ["build", "verify", "render", "serve", "mcp"]) assert.match(h.out, new RegExp(s));
  const bad = run(["codemap", "nope"]);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /unknown codemap subcommand 'nope'/);
});

test("codemap verify + render work end-to-end on a codemap directory", () => {
  const v = run(["codemap", "verify", CODEMAP_DIR]);
  assert.equal(v.code, 0, v.err);
  assert.match(v.err, /documents pass geml check/);
  const r = run(["codemap", "render", CODEMAP_DIR]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /rendered 2 page\(s\)/);
  assert.ok(existsSync(pjoin(CODEMAP_DIR, "index.html")), "index.html baked");
  assert.match(rf(pjoin(CODEMAP_DIR, "auth.html"), "utf8"), /cg-mount/, "container page carries the graph mount");
});

// The serve test is async (spawns the server, fetches) — awaited at top level
// so its assertions land before the summary line.
async function testAsync(name, fn) { await fn(); passed++; console.log("ok", name); }

await testAsync("codemap serve renders pages live, answers HEAD, and refuses traversal", async () => {
  const { spawn } = await import("node:child_process");
  const port = 8791 + (process.pid % 100); // avoid collisions across CI runs
  const child = spawn(process.execPath, ["dist/geml.js", "codemap", "serve", CODEMAP_DIR, "--port", String(port)], { stdio: ["ignore", "ignore", "pipe"] });
  try {
    // wait for the listen banner
    await new Promise((resolveP, rejectP) => {
      const to = setTimeout(() => rejectP(new Error("serve did not start")), 8000);
      child.stderr.on("data", (d) => { if (String(d).includes("http://localhost")) { clearTimeout(to); resolveP(); } });
      child.on("exit", () => rejectP(new Error("serve exited early")));
    });
    const get = async (path, method = "GET") => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
      return { status: res.status, body: method === "HEAD" ? "" : await res.text(), type: res.headers.get("content-type") || "" };
    };
    const idx = await get("/");
    assert.equal(idx.status, 200);
    assert.match(idx.body, /cg-mount/, "index rendered live from index.geml");
    assert.match(idx.type, /text\/html/);
    const head = await get("/auth.html", "HEAD");
    assert.equal(head.status, 200, "HEAD probe: target page exists (in-page nav relies on this)");
    const miss = await get("/nope.html", "HEAD");
    assert.equal(miss.status, 404, "HEAD probe: missing page is a 404, not a render error");
    const raw = await get("/auth.geml");
    assert.equal(raw.status, 200);
    assert.match(raw.type, /text\/plain/, "raw .geml served as text");
    // WHATWG URL parsing already normalizes /../ and /%2e%2e/ away; the
    // resolve() guard is defence-in-depth for what survives parsing — on
    // Windows, encoded backslashes. Either way the file must not be served.
    const evil = await get("/%5c..%5c..%5cpackage.json");
    assert.notEqual(evil.status, 200, "path traversal refused");
  } finally {
    child.kill();
    await new Promise((r) => { child.once("exit", r); setTimeout(r, 2000).unref(); });
  }
});

console.log(`\n${passed} test(s) passed.`);
