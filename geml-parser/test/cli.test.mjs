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
  // timeout: a CLI that blocks (e.g. reading a stdin that never EOFs on CI)
  // must fail loudly as ETIMEDOUT, not hang the whole job in silence.
  const r = spawnSync(process.execPath, ["dist/geml.js", ...args], { input, encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const GOOD = "=== note {#n}\nok, see [[#n]]\n===\n";
const BAD = "=== code {#c}\nunterminated, no closing fence\n"; // missing ===

test("--help exits 0 and lists the commands", () => {
  const r = run(["--help"]);
  assert.equal(r.code, 0);
  for (const c of ["--to", "get", "set", "add", "delete", "rename", "revert", "check", "history", "codemap"]) assert.match(r.out, new RegExp(c));
  // the reclaimed verbs are gone from the usage block
  assert.doesNotMatch(r.out, /geml (render|export|convert|fmt) /);
});

test("--version exits 0 and prints a version", () => {
  const r = run(["--version"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /\d/);
});

test("runs when launched through an extensionless bin symlink (npm's unix shim)", () => {
  // npm links node_modules/.bin/geml -> dist/geml.js; argv[1] is then the
  // symlink path, which must still be recognised as the CLI entry.
  const bin = pjoin(mkdtempSync(pjoin(tmpdir(), "geml-bin-")), "geml");
  try {
    symlinkSync(presolve("dist/geml.js"), bin);
  } catch {
    console.log("skip (symlinks unavailable)");
    return;
  }
  const r = spawnSync(process.execPath, [bin, "--version"], { encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0);
  assert.match(r.stdout ?? "", /\d/, "bin symlink invocation must print the version, not exit silently");
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

// A minimal repo-shaped tree for the `check --root` tests: the input lives in
// a subdirectory and references a file one level up — inside the granted root.
function mkRootTree() {
  const repo = pjoin(mkdtempSync(pjoin(tmpdir(), "geml-cli-root-")), "repo");
  mkdirSync(pjoin(repo, "docs"), { recursive: true });
  wf(pjoin(repo, "README.md"), "# readme\n");
  wf(pjoin(repo, "docs", "main.geml"), "# Main {#top}\n\nup [a](../README.md)\n");
  return repo;
}

test("check --root: a repo-relative ../ ref checks clean when the root is granted", () => {
  const repo = mkRootTree();
  try {
    const r = run(["check", pjoin(repo, "docs", "main.geml"), "--root", repo]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /ok: no diagnostics/);
  } finally { rmSync(pjoin(repo, ".."), { recursive: true, force: true }); }
});

test("check --root before the file works too (the root value is not mistaken for the input)", () => {
  const repo = mkRootTree();
  try {
    const r = run(["check", "--root", repo, pjoin(repo, "docs", "main.geml")]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /ok: no diagnostics/);
  } finally { rmSync(pjoin(repo, ".."), { recursive: true, force: true }); }
});

test("check --root naming a missing path is a usage error (exit 2), not a wall of resolve errors", () => {
  const repo = mkRootTree();
  try {
    const r = run(["check", pjoin(repo, "docs", "main.geml"), "--root", pjoin(repo, "nope")]);
    assert.equal(r.code, 2);
    assert.match(r.err, /--root .* is not a directory/);
    assert.doesNotMatch(r.err, /cannot resolve document/);
  } finally { rmSync(pjoin(repo, ".."), { recursive: true, force: true }); }
});

test("check --root naming a file (not a directory) is a usage error (exit 2)", () => {
  const repo = mkRootTree();
  try {
    const r = run(["check", pjoin(repo, "docs", "main.geml"), "--root", pjoin(repo, "README.md")]);
    assert.equal(r.code, 2);
    assert.match(r.err, /--root .* is not a directory/);
  } finally { rmSync(pjoin(repo, ".."), { recursive: true, force: true }); }
});

test("dogfood: the repo's own COMPARISON docs check clean with --root at the repo root", () => {
  // docs/comparisons/COMPARISON*.geml reference ../../spec/*.md and ../../README*.md — exactly
  // the case --root exists for. This is the CI story: without the grant the
  // repo's own documents cannot pass their own check.
  for (const f of ["../docs/comparisons/COMPARISON.geml", "../docs/comparisons/COMPARISON_CN.geml"]) {
    const r = run(["check", f, "--root", ".."]);
    assert.equal(r.code, 0, `${f}: ${r.err}`);
    assert.match(r.err, /ok: no diagnostics/);
  }
});

test("--to geml on a broken doc exits non-zero (no silent success)", () => {
  const r = run(["-", "--to", "geml"], BAD);
  assert.equal(r.code, 1);
  assert.match(r.err, /error/);
});

test("--to geml on a clean doc exits 0 and round-trips through stdin", () => {
  const r = run(["-", "--to", "geml"], GOOD);
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

test("--to md emits Markdown from stdin and exits 0 on a clean doc", () => {
  const r = run(["-", "--to", "md"], "# H\n\n=== code {lang=js}\nx=1\n===\n");
  assert.equal(r.code, 0);
  assert.match(r.out, /^# H/m);
  assert.match(r.out, /```js\nx=1\n```/);
});

test("--to md exits non-zero on a broken doc (same signal as --to html)", () => {
  const r = run(["-", "--to", "md"], "=== code {#c}\nunterminated\n");
  assert.equal(r.code, 1);
  assert.match(r.err, /error/);
});

// ---------------------------------------------------------------------------
// geml codemap — the code-graph toolkit dispatch (build/verify/render/serve)
// ---------------------------------------------------------------------------

// A minimal two-document codemap on disk (same shape the emitter writes).
import { mkdtempSync, mkdirSync, writeFileSync as wf, readFileSync as rf, existsSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join as pjoin, resolve as presolve } from "node:path";
// Isolate the C2 recipe-trust store per run (audit): starts empty, never
// touches ~/.config; run() inherits process.env so refresh children see it.
process.env.GEML_TRUST_STORE = pjoin(mkdtempSync(pjoin(tmpdir(), "geml-trust-cli-")), "store.json");
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
  for (const s of ["build", "verify", "render", "serve", "refresh", "find"]) assert.match(h.out, new RegExp(s));
  // `mcp` was removed as a codemap subcommand — `geml mcp --root <dir>` serves
  // those tools now. Advertising it here would send an operator to an entry
  // point that no longer exists.
  assert.ok(!/codemap mcp/.test(h.out), "the removed subcommand is not advertised");
  const bad = run(["codemap", "nope"]);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /unknown codemap subcommand 'nope'/);
});

test("codegraph / code-graph alias to codemap (people reconstruct the command from the .geml-code-graph dir name)", () => {
  for (const alias of ["codegraph", "code-graph"]) {
    const h = run([alias, "--help"]);
    assert.equal(h.code, 0, h.err);
    assert.match(h.out, /geml codemap build/);
    const bad = run([alias, "nope"]);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /unknown codemap subcommand 'nope'/);
  }
  const v = run(["codegraph", "verify", CODEMAP_DIR]);
  assert.equal(v.code, 0, v.err);
  assert.match(v.err, /documents pass geml check/);
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

test("codemap refresh: replays the recorded recipe; hook mode filters and never blocks", () => {
  // no recipe: plain call errors with a pointer, hook mode is a silent no-op
  const bare = mkdtempSync(pjoin(tmpdir(), "geml-refresh-"));
  const none = run(["codemap", "refresh", bare]);
  assert.equal(none.code, 1);
  assert.match(none.err, /refresh\.json not found/);
  const hookNone = run(["codemap", "refresh", bare, "--hook"], JSON.stringify({ tool_input: { command: "git commit -m x" } }));
  assert.equal(hookNone.code, 0, "un-opted-in project: hook exits 0 silently");

  // record a recipe (no git in the tmp dir -> runs unconditionally)
  const proj = mkdtempSync(pjoin(tmpdir(), "geml-refresh-proj-"));
  const cm = pjoin(proj, "codemap");
  const ix = pjoin(cm, "_index");
  mkdirSync(ix, { recursive: true });
  wf(pjoin(ix, "refresh.json"), JSON.stringify({
    version: 1,
    root: "..",
    steps: [{ argv: [process.execPath, "-e", "require('fs').writeFileSync('marker.txt','ran')"] }],
  }));
  const r = run(["codemap", "refresh", cm, "--trust"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /done/);
  assert.equal(rf(pjoin(proj, "marker.txt"), "utf8"), "ran", "step ran with the project root as cwd");
  assert.match(rf(pjoin(ix, "refresh.log"), "utf8"), /\$ .*marker/, "log records the step");

  // a step that floods stdout must NOT be killed — output streams to the log
  // file (spawnSync's in-memory capture has a 1MB maxBuffer; Joern's INFO
  // firehose used to blow it and the child died with exit null)
  wf(pjoin(ix, "refresh.json"), JSON.stringify({
    version: 1,
    root: "..",
    steps: [{ argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(2*1024*1024)); require('fs').writeFileSync('big.txt','done')"] }],
  }));
  const big = run(["codemap", "refresh", cm, "--trust"]);
  assert.equal(big.code, 0, big.err);
  assert.equal(rf(pjoin(proj, "big.txt"), "utf8"), "done", "2MB-output step survived to completion");

  // a failing step exits 1 and names the step
  wf(pjoin(ix, "refresh.json"), JSON.stringify({ version: 1, root: "..", steps: [{ argv: [process.execPath, "-e", "process.exit(3)"] }] }));
  const bad = run(["codemap", "refresh", cm, "--trust"]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /step failed \(exit 3\)/);

  // hook mode: non-commit commands are filtered out instantly
  const skip = run(["codemap", "refresh", cm, "--hook"], JSON.stringify({ tool_input: { command: "git status" } }));
  assert.equal(skip.code, 0);
  assert.equal(skip.err.trim(), "", "non-commit: no output, no refresh");
  // ...a commit spawns the background run and returns at once
  const go = run(["codemap", "refresh", cm, "--hook"], JSON.stringify({ tool_input: { command: "envwrap git add . && envwrap git commit -m done" } }));
  assert.equal(go.code, 0);
  assert.match(go.err, /background/);
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

await testAsync("codemap serve --background: outlives the launcher; --stop ends it", async () => {
  const port = 8901 + (process.pid % 97);
  // the launcher (spawnSync) EXITS here — anything still serving afterwards
  // is by definition detached from it
  const r = run(["codemap", "serve", CODEMAP_DIR, "--port", String(port), "--background"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /background/);
  assert.match(r.err, /survives this session/);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { method: "HEAD" });
    assert.equal(res.status, 200, "server answers after its launcher exited");
    assert.ok(existsSync(pjoin(CODEMAP_DIR, "_index", "serve.pid")), "pid recorded for --stop");
    // second --background reuses, never stacks
    const again = run(["codemap", "serve", CODEMAP_DIR, "--port", String(port), "--background"]);
    assert.equal(again.code, 0);
    assert.match(again.err, /already answers/);
  } finally {
    const s = run(["codemap", "serve", CODEMAP_DIR, "--stop"]);
    assert.equal(s.code, 0, s.err);
    assert.match(s.err, /stopped \(pid \d+\)/);
  }
  await new Promise((r2) => setTimeout(r2, 300));
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`, { method: "HEAD" }), "stopped server no longer answers");
  const s2 = run(["codemap", "serve", CODEMAP_DIR, "--stop"]);
  assert.equal(s2.code, 0);
  assert.match(s2.err, /nothing to stop/);
});

test("--to md expands an embed in place, like --to html has always done", () => {
  // The two exports used to disagree about the same document: html inlined the
  // projected content, md emitted `[#src](#src)` — a link, where the reader
  // came for the text. An export is a snapshot and a snapshot carries content.
  const d = mkdtempSync(pjoin(tmpdir(), "geml-embedmd-"));
  const f = pjoin(d, "same.geml");
  wf(f, '=== meta\ntitle = "T"\n===\n\n=== note {#src}\nthe projected text.\n===\n\n## Where {#w}\n\n=== embed {src=#src}\n===\n');
  const r = run([f, "--to", "md"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /the projected text\./, "the content stands where the embed was");
  assert.doesNotMatch(r.out, /\[#src\]\(#src\)/, "and not a link to it");
  assert.match(r.err, /expanded in place/, "the loss reported is the machinery, not the content");
  // Cross-document too, through the same walk `--view` uses.
  wf(pjoin(d, "lib.geml"), '=== meta\ntitle = "Lib"\n===\n\n=== note {#shared}\nfrom the other file.\n===\n');
  const host = pjoin(d, "host.geml");
  wf(host, '=== meta\ntitle = "Host"\n===\n\n=== embed {src=lib.geml#shared}\n===\n');
  assert.match(run([host, "--to", "md"]).out, /from the other file\./);
  // What cannot be read cannot be inlined: a link keeps the target findable.
  const bad = pjoin(d, "bad.geml");
  wf(bad, '=== meta\ntitle = "Bad"\n===\n\n=== embed {src=nope.geml#gone}\n===\n');
  const fb = run([bad, "--to", "md"]);
  assert.match(fb.out, /\[nope\.geml#gone\]\(nope\.geml#gone\)/, "falls back to a link");
  assert.match(fb.err, /could not be resolved/);
  rmSync(d, { recursive: true, force: true });
});


// --- the library/CLI split (geml.ts is the library, cli.ts is the command)

test("both entries behave identically — the legacy dist/geml.js still runs the CLI", () => {
  const viaCli = spawnSync(process.execPath, ["dist/cli.js", "--version"], { encoding: "utf8", timeout: 60_000 });
  const viaLegacy = spawnSync(process.execPath, ["dist/geml.js", "--version"], { encoding: "utf8", timeout: 60_000 });
  assert.equal(viaCli.status, 0);
  assert.equal(viaLegacy.status, 0, "hooks, codemap recipes and older docs all invoke dist/geml.js");
  assert.equal((viaLegacy.stdout ?? "").trim(), (viaCli.stdout ?? "").trim());
});

test("importing the library never starts the CLI — even from a script named geml.js", () => {
  // The hand-off tests for THIS file being the script, not for a filename that
  // ends in geml.js: someone else's geml.js importing `parse` must not have the
  // CLI print usage and exit their process.
  const dir = mkdtempSync(pjoin(tmpdir(), "geml-asLib-"));
  const lib = pathToFileURL(presolve("dist/geml.js")).href;
  wf(pjoin(dir, "geml.js"),
    `import { parse } from ${JSON.stringify(lib)};\n` +
    // The GEML source has to reach the generated file as the two characters
    // `\` `n`, not as real newlines — those would end the string literal.
    `const d = parse("=== note {#n}\\nhi\\n===\\n");\n` +
    `console.log("blocks:" + d.children.length);\n`);
  const r = spawnSync(process.execPath, [pjoin(dir, "geml.js")], { encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout ?? "", /blocks:1/);
  assert.doesNotMatch(r.stdout ?? "", /GEML reference CLI/, "the CLI must not have run");
  rmSync(dir, { recursive: true, force: true });
});

test("the library imports nothing from node that a browser bundle cannot stub", () => {
  // The whole point of the split: CLI-side imports (fs writes, os, child_process)
  // live in cli.ts now, so adding one can no longer break the viewer build.
  const src = rf("src/geml.ts", "utf8");
  const nodeImports = [...src.matchAll(/^import \{([^}]*)\} from "node:(\w+)";/gm)]
    .map(([, names, mod]) => [mod, names.split(",").map((s) => s.trim().split(" ")[0])]);
  const flat = nodeImports.flatMap(([mod, names]) => names.map((n) => `${mod}.${n}`));
  // Each of these has a stub in codemap/browser-stub.mjs, which is what the
  // viewer aliases node: modules to — that stub, not this list, is the real
  // contract. `fs.realpathSync` is here because the "am I being run as the
  // CLI?" check has to live in this entry (dist/geml.js is the legacy one) and
  // the shim it must recognise is a symlink; the stub answers it with identity.
  const allowed = ["fs.readFileSync", "fs.realpathSync", "path.dirname", "path.join", "path.resolve", "url.fileURLToPath"];
  const extra = flat.filter((n) => !allowed.includes(n));
  assert.deepEqual(extra, [], `the library grew a node import: ${extra.join(", ")} — does it belong in cli.ts?`);
});


test("the two exports agree on WHAT they carry: whatever --to html shows, --to md shows", () => {
  // Not a test of one bug but of the rule behind three of them. `--to html` was
  // given a document resolver and `--to md` was not, so the same document
  // exported two ways disagreed about whether the reader sees content:
  //   `=== embed`      html inlined it,  md emitted a link
  //   `![[#id]]`       html inlined it,  md emitted a link
  //   `data {src=}`    html showed it,   md emitted an EMPTY fence, silently
  // The shapes differ by design — html has <td>, md has pipes — so this asserts
  // presence of the CONTENT, which neither format has an excuse to drop.
  const d = mkdtempSync(pjoin(tmpdir(), "geml-parity-"));
  wf(pjoin(d, "lib.geml"), '=== meta\ntitle = "Lib"\n===\n\n=== note {#shared}\nCROSSDOC words.\n===\n');
  wf(pjoin(d, "rows.csv"), "a,b\n7,8\n");
  wf(pjoin(d, "val.json"), '{"deep":{"n":42}}\n');
  const f = pjoin(d, "all.geml");
  wf(f, [
    '=== meta', 'title = "Parity"', '===', '',
    '=== text {#frag}', 'INLINEFRAG words.', '===', '',
    '=== note {#nt}', 'NOTEBODY text.', '===', '',
    '=== code {#cd lang=python}', 'CODEBODY = 1', '===', '',
    '=== table {#tb format=csv header=1 src=rows.csv}', '===', '',
    '=== data {#dt src=val.json}', '===', '',
    '=== embed {src=lib.geml#shared}', '===', '',
    '## Uses {#u}', '', 'inline: ![[#frag]] end.', '',
  ].join("\n"));

  const html = run([f, "--to", "html"]);
  const md = run([f, "--to", "md"]);
  assert.equal(html.code, 0, html.err);
  assert.equal(md.code, 0, md.err);

  // Every one of these is content a reader came for. Both exports must carry it.
  for (const needle of ["INLINEFRAG", "NOTEBODY", "CODEBODY", "CROSSDOC", "42", "7", "8"]) {
    assert.ok(html.out.includes(needle), `--to html dropped ${needle}`);
    assert.ok(md.out.includes(needle), `--to md dropped ${needle} — the exports disagree`);
  }
  // And md must not fall back to a link when it could resolve.
  assert.doesNotMatch(md.out, /\[#frag\]\(#frag\)/, "inline projection linked instead of expanded");
  assert.doesNotMatch(md.out, /\[lib\.geml#shared\]/, "embed linked instead of expanded");
  // An empty fence is how the data loss looked; it must not come back.
  assert.doesNotMatch(md.out, /```json\r?\n```/, "empty fence: a data value went missing in silence");
  rmSync(d, { recursive: true, force: true });
});

console.log(`\n${passed} test(s) passed.`);
// Exit explicitly: every assertion above has run, and on Linux this file's
// server/fetch traffic can leave a live handle that keeps the process — and
// with it the whole npm-test chain — hanging (observed on CI: the summary
// printed, then 20 silent minutes until the job timeout). V8 coverage is
// still flushed on process.exit.
process.exit(0);
