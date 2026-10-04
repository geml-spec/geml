// What program the extension starts, and when.
//
// Opening a document is all it takes to run the CLI, so a cloned folder must
// not get to choose that program: not in Restricted Mode, where nothing runs
// at all, and not through the folder the CLI runs in, which is the document's
// own. These tests watch spawn itself — the argv, the cwd, the environment —
// rather than a CLI's answer, because the question is what would have run.

const { strict: assert } = require("node:assert");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { makeDoc, install, setSetting, vscode } = require("./vscode-stub.cjs");

install();

// Every spawn is recorded. `realSpawn` lets one test run the program for real.
const calls = [];
const realSpawn = childProcess.spawn;
let passThrough = false;
childProcess.spawn = (bin, args, opts) => {
  calls.push({ bin, args, cwd: opts?.cwd, shell: opts?.shell, env: opts?.env });
  if (passThrough) return realSpawn(bin, args, opts);
  const p = new EventEmitter();
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.stdin = Object.assign(new EventEmitter(), { end() {} });
  setImmediate(() => { p.stdout.emit("data", "[]"); p.emit("close", 0); });
  return p;
};

const warnings = [];
vscode.window.showWarningMessage = (m) => { warnings.push(m); };

const cli = require("../out/cli.js");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok", name); }
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

const base = mkdtempSync(path.join(tmpdir(), "geml-spawn-"));
const savedPath = process.env.PATH;
const savedPathext = process.env.PATHEXT;

// A folder as a cloned repository might ship it: a document, and a `geml` of
// its own beside it — the program a cwd-relative lookup would find.
function repo(name, files = ["geml"]) {
  const dir = path.join(base, name);
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    writeFileSync(path.join(dir, f), `#!/bin/sh\necho repo > "${path.join(dir, "RAN")}"\n`);
    chmodSync(path.join(dir, f), 0o755);
  }
  writeFileSync(path.join(dir, "README.geml"), "# Notes\n");
  return dir;
}

// The CLI the user installed: a `geml` in a directory on PATH.
function installed(name, files = ["geml"]) {
  const dir = path.join(base, name);
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    writeFileSync(path.join(dir, f), `#!/bin/sh\necho '[]'\n`);
    chmodSync(path.join(dir, f), 0o755);
  }
  return dir;
}

async function main() {

await test("round 6: no CLI process starts while the workspace is untrusted", async () => {
  const dir = repo("untrusted");
  process.env.PATH = installed("bin-untrusted");
  const doc = makeDoc("# Notes\n", { path: path.join(dir, "README.geml"), version: 1 });
  calls.length = 0;
  vscode.workspace.isTrusted = false;
  try {
    assert.equal(await cli.runCli(doc, ["check", "--json", "-"]), null);
    assert.equal(await cli.listUnits(doc), null);
    assert.equal(await cli.runCliOnFile(doc.uri, ["history", "get", "README.geml", "--json"]), null);
    assert.equal(await cli.spawnCli(["find", "notes", ".", "--json"], { cwd: dir }), null);
    assert.deepEqual(calls, [], "nothing was started");
  } finally {
    vscode.workspace.isTrusted = true;
  }
  // And nothing was remembered: once trusted, the same document version is asked for.
  assert.deepEqual(await cli.listUnits(doc), []);
  assert.equal(calls.length, 1, "trusted, the index is asked of the CLI");
});

await test("round 6: in Restricted Mode, opening a document starts nothing until the folder is trusted", async () => {
  const dir = repo("restricted");
  process.env.PATH = installed("bin-restricted");
  const doc = makeDoc("# Notes\n", { path: path.join(dir, "README.geml"), version: 1 });
  const handlers = { open: [], grant: [] };
  const registered = [];
  const disposable = { dispose() {} };
  const on = (list) => (f) => { list.push(f); return disposable; };
  const provider = (kind) => () => { registered.push(kind); return disposable; };
  Object.assign(vscode.workspace, {
    textDocuments: [doc],
    onDidOpenTextDocument: on(handlers.open),
    onDidChangeTextDocument: () => disposable,
    onDidSaveTextDocument: () => disposable,
    onDidCloseTextDocument: () => disposable,
    onDidGrantWorkspaceTrust: on(handlers.grant),
  });
  vscode.languages = {
    createDiagnosticCollection: () => ({ set() {}, delete() {}, clear() {}, dispose() {} }),
    registerDocumentSymbolProvider: provider("symbols"),
    registerFoldingRangeProvider: provider("folding"),
    registerHoverProvider: provider("hover"),
    registerDefinitionProvider: provider("definition"),
    registerRenameProvider: provider("rename"),
    registerWorkspaceSymbolProvider: provider("workspace-symbols"),
  };
  vscode.commands = { registerCommand: () => disposable };
  vscode.window.registerWebviewPanelSerializer = () => disposable;
  vscode.DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2 };
  vscode.Diagnostic = class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } };

  calls.length = 0;
  vscode.workspace.isTrusted = false;
  const ext = require("../out/extension.js");
  ext.activate({ subscriptions: { push() {} }, extensionUri: vscode.Uri.file(__dirname) });
  for (const h of handlers.open) h(doc);
  await settle(400);   // past the 250 ms debounce before a check
  assert.deepEqual(calls, [], "opening a document in Restricted Mode starts no process");
  assert.deepEqual(registered, [], "and no CLI-backed provider is registered to start one");

  vscode.workspace.isTrusted = true;
  for (const h of handlers.grant) h();
  await settle(400);
  assert.ok(registered.includes("symbols") && registered.includes("workspace-symbols"), "trust starts the features");
  assert.ok(calls.some((c) => c.args.includes("check")), "and checks the documents already open");
  ext.deactivate();
});

await test("round 6: the CLI is started by absolute path, never found in the document's folder", async () => {
  const dir = repo("posix");
  const bin = installed("bin-posix");
  // `.` first, as a careless PATH has it: a lookup that honoured it in the
  // document's folder would run the repository's `geml`.
  process.env.PATH = ["."].concat(bin).join(path.delimiter);
  const doc = makeDoc("# Notes\n", { path: path.join(dir, "README.geml"), version: 1 });
  calls.length = 0;
  await cli.runCli(doc, ["check", "--json", "-"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, path.join(bin, "geml"), "the installed CLI, by absolute path");
  assert.equal(calls[0].cwd, dir, "still run in the document's folder, so relative references resolve");
  assert.ok(!calls[0].shell, "with no shell");
  assert.ok(!calls[0].env.PATH.split(path.delimiter).includes("."), "and the relative PATH entry is not handed on");

  if (process.platform !== "win32") {
    // For real, on POSIX: the repository's `geml` must not be what runs.
    calls.length = 0;
    passThrough = true;
    try {
      const r = await cli.runCli(doc, ["check", "--json", "-"]);
      assert.ok(r, "the installed CLI ran");
      assert.equal(r.stdout.trim(), "[]");
    } finally { passThrough = false; }
    assert.ok(!existsSync(path.join(dir, "RAN")), "the repository's own `geml` never ran");
  }
});

await test("round 6: on Windows a .cmd shim runs by absolute path, and cmd.exe does not search the document's folder", async () => {
  const dir = repo("win", ["geml.cmd"]);
  const bin = installed("bin-win", ["geml.cmd"]);
  process.env.PATH = bin;
  process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
  // WIN is read when the module loads, so load a second copy as Windows sees it.
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  const modulePath = require.resolve("../out/cli.js");
  delete require.cache[modulePath];
  Object.defineProperty(process, "platform", { value: "win32" });
  let winCli;
  try { winCli = require(modulePath); } finally {
    Object.defineProperty(process, "platform", real);
    delete require.cache[modulePath];
  }
  const doc = makeDoc("# Notes\n", { path: path.join(dir, "README.geml"), version: 1 });
  calls.length = 0;
  await winCli.runCli(doc, ["check", "--json", "-"]);
  assert.equal(calls.length, 1);
  // PATHEXT spells the extension; Windows matches it in any case.
  assert.equal(calls[0].bin.toLowerCase(), path.join(bin, "geml.cmd").toLowerCase(), "npm's shim, by absolute path");
  assert.equal(calls[0].shell, true, "through cmd.exe, the only thing that runs a .cmd");
  assert.equal(calls[0].env.NoDefaultCurrentDirectoryInExePath, "1",
    "so the `node` the shim names is looked up on PATH, not in the document's folder");
});

await test("round 6: a package runner in geml.check.path is refused, not started", async () => {
  const dir = repo("runner");
  process.env.PATH = installed("bin-runner", ["npx", "pnpm"]);
  const doc = makeDoc("# Notes\n", { path: path.join(dir, "README.geml"), version: 1 });
  warnings.length = 0;
  try {
    for (const setting of ["npx @geml/geml", "pnpm dlx @geml/geml", `${process.env.PATH}${path.sep}npx --yes @geml/geml`]) {
      setSetting("geml.check.path", setting);
      calls.length = 0;
      assert.equal(await cli.runCli(doc, ["check", "--json", "-"]), null, setting);
      assert.deepEqual(calls, [], `${setting}: nothing started`);
    }
    // Once per runner, not once per keystroke: the third is npx again.
    assert.equal(warnings.length, 2, JSON.stringify(warnings));
    assert.match(warnings[0], /npx.*node_modules/, "and the message says why");
  } finally {
    setSetting("geml.check.path", "geml");
  }
});

  console.log(`\n${passed} test(s) passed.`);
}

main()
  .catch((e) => { console.error("not ok —", e.stack || e.message); process.exitCode = 1; })
  .finally(() => {
    process.env.PATH = savedPath;
    if (savedPathext === undefined) delete process.env.PATHEXT; else process.env.PATHEXT = savedPathext;
    rmSync(base, { recursive: true, force: true });
  });
