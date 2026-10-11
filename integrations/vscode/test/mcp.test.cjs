// Which MCP servers the extension offers.
//
// plan() is the whole of the extension's own judgement here — the editor's API
// does the rest — so it is exactly what wants a test. Two things it decides are
// security rules rather than preferences, and both are checked below: the hosted
// endpoint must be TLS (every call carries the whole document, and workers.dev
// answers plain http with a 200 rather than a redirect), and the folder's path
// must never enter argv, because on Windows a `geml.cmd` shim puts argv through
// cmd.exe, where `C:\work\a&b` is two commands.

const { strict: assert } = require("node:assert");
const { install, setSetting, vscode } = require("./vscode-stub.cjs");

install();
const { plan, HOSTED_URL } = require("../out/mcp.js");
const { invocation } = require("../out/cli.js");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const POSIX_CLI = { bin: "/usr/local/bin/geml", lead: [] };
const WIN_CLI = { bin: "C:\\Users\\a\\AppData\\Roaming\\npm\\geml.cmd", lead: [] };
const ONE_FOLDER = [{ name: "project", path: "/home/a/project" }];

const input = (over = {}) => ({
  choice: "both",
  url: HOSTED_URL,
  trusted: true,
  folders: ONE_FOLDER,
  cli: POSIX_CLI,
  windows: false,
  comspec: undefined,
  ...over,
});

// ---- what gets offered -----------------------------------------------------

test("by default both servers are offered, hosted first", () => {
  const got = plan(input());
  assert.deepEqual(got.map((s) => s.kind), ["http", "stdio"]);
  assert.equal(got[0].url, HOSTED_URL);
  assert.equal(got[0].label, "GEML (hosted)");
  assert.equal(got[1].label, "GEML (local)");
});

test("the local server runs `geml mcp --root .` in the folder", () => {
  const [, local] = plan(input());
  assert.equal(local.command, "/usr/local/bin/geml");
  assert.deepEqual(local.args, ["mcp", "--root", "."]);
  assert.equal(local.cwd, "/home/a/project");
});

test("arguments the user put in geml.check.path lead the CLI's own", () => {
  const [, local] = plan(input({ cli: { bin: "/usr/bin/node", lead: ["/abs/cli.js"] } }));
  assert.equal(local.command, "/usr/bin/node");
  assert.deepEqual(local.args, ["/abs/cli.js", "mcp", "--root", "."]);
});

test("each choice offers what it says", () => {
  assert.deepEqual(plan(input({ choice: "hosted" })).map((s) => s.kind), ["http"]);
  assert.deepEqual(plan(input({ choice: "local" })).map((s) => s.kind), ["stdio"]);
  assert.deepEqual(plan(input({ choice: "none" })), []);
});

test("Restricted Mode offers the hosted server and no local one", () => {
  assert.deepEqual(plan(input({ trusted: false })).map((s) => s.kind), ["http"]);
});

test("no CLI, no local server — and the hosted one still stands", () => {
  assert.deepEqual(plan(input({ cli: null })).map((s) => s.kind), ["http"]);
});

test("no folder open, no local server", () => {
  assert.deepEqual(plan(input({ folders: [] })).map((s) => s.kind), ["http"]);
});

test("a multi-root window gets one local server per folder, named after it", () => {
  const got = plan(input({
    folders: [{ name: "spec", path: "/w/spec" }, { name: "site", path: "/w/site" }],
  }));
  assert.deepEqual(got.map((s) => s.label), ["GEML (hosted)", "GEML (spec)", "GEML (site)"]);
  assert.deepEqual(got.slice(1).map((s) => s.cwd), ["/w/spec", "/w/site"]);
});

// ---- the endpoint has to be TLS -------------------------------------------

test("https is the endpoint we send documents to", () => {
  const [hosted] = plan(input({ url: "https://mcp.example.test/mcp" }));
  assert.equal(hosted.url, "https://mcp.example.test/mcp");
});

test("plain http is refused — workers.dev answers it with a 200, not a redirect", () => {
  const url = HOSTED_URL.replace("https:", "http:");
  assert.deepEqual(plan(input({ url })).map((s) => s.kind), ["stdio"]);
});

test("http is allowed on loopback, which is `wrangler dev`", () => {
  for (const url of ["http://localhost:8787/mcp", "http://127.0.0.1:8787/mcp"]) {
    const [hosted] = plan(input({ url }));
    assert.equal(hosted.kind, "http", url);
  }
});

test("a URL that is not one is refused rather than guessed at", () => {
  for (const url of ["", "   ", "geml-mcp.supermarket.workers.dev/mcp", "file:///etc/passwd", "ftp://h/mcp"]) {
    assert.deepEqual(plan(input({ url })).map((s) => s.kind), ["stdio"], JSON.stringify(url));
  }
});

test("surrounding whitespace in the setting does not disqualify it", () => {
  const [hosted] = plan(input({ url: `  ${HOSTED_URL}  ` }));
  assert.equal(hosted.kind, "http");
});

// ---- Windows: a .cmd shim cannot be spawned without a shell ----------------

test("a geml.cmd shim is started through cmd.exe, quoted", () => {
  const [, local] = plan(input({ windows: true, cli: WIN_CLI, comspec: "C:\\WINDOWS\\system32\\cmd.exe" }));
  assert.equal(local.command, "C:\\WINDOWS\\system32\\cmd.exe");
  assert.deepEqual(local.args, ["/d", "/s", "/c", WIN_CLI.bin, "mcp", "--root", "."]);
  assert.equal(local.cwd, "/home/a/project");
});

test("a space in the shim's path is quoted for cmd.exe", () => {
  const bin = "C:\\Program Files\\nodejs\\geml.cmd";
  const [, local] = plan(input({ windows: true, cli: { bin, lead: [] }, comspec: "cmd.exe" }));
  assert.equal(local.args[3], `"${bin}"`);
});

test("an .exe on Windows needs no shell", () => {
  const bin = "C:\\tools\\geml.exe";
  const [, local] = plan(input({ windows: true, cli: { bin, lead: [] }, comspec: "cmd.exe" }));
  assert.equal(local.command, bin);
  assert.deepEqual(local.args, ["mcp", "--root", "."]);
});

test("no ComSpec, no local server — guessing at cmd.exe's path is not better than saying no", () => {
  assert.deepEqual(
    plan(input({ windows: true, cli: WIN_CLI, comspec: undefined })).map((s) => s.kind),
    ["http"],
  );
  assert.deepEqual(
    plan(input({ windows: true, cli: WIN_CLI, comspec: "" })).map((s) => s.kind),
    ["http"],
  );
});

test("a shim whose own path is hostile to a command line is refused, not escaped", () => {
  for (const bin of ["C:\\a&b\\geml.cmd", "C:\\%PATH%\\geml.cmd", "C:\\a^b\\geml.cmd"]) {
    assert.deepEqual(
      plan(input({ windows: true, cli: { bin, lead: [] }, comspec: "cmd.exe" })).map((s) => s.kind),
      ["http"],
      bin,
    );
  }
});

test("the folder's path never reaches argv, on any platform", () => {
  const folders = [{ name: "a&b", path: "C:\\work\\a&b %PATH%" }];
  for (const over of [
    { folders },
    { folders, windows: true, cli: WIN_CLI, comspec: "cmd.exe" },
    { folders, windows: true, cli: { bin: "C:\\tools\\geml.exe", lead: [] }, comspec: "cmd.exe" },
  ]) {
    const local = plan(input(over)).find((s) => s.kind === "stdio");
    assert.ok(local, "a local server was offered");
    assert.ok(!local.args.some((a) => a.includes("a&b")), JSON.stringify(local.args));
    assert.equal(local.cwd, folders[0].path);
  }
});

// ---- looking for the CLI must not become a popup ---------------------------

test("a missing CLI is silent when the editor is the one asking", () => {
  // Quiet first: warnOnce only ever says a thing once, so a loud call before
  // this one would make it pass for the wrong reason.
  const said = [];
  const original = vscode.window.showWarningMessage;
  vscode.window.showWarningMessage = (m) => { said.push(m); };
  try {
    setSetting("geml.check.path", "geml-that-is-not-installed-anywhere");
    assert.equal(invocation(true), null);
    assert.deepEqual(said, []);
    assert.equal(invocation(), null);
    assert.equal(said.length, 1, "a feature the user did ask for still says why");
  } finally {
    vscode.window.showWarningMessage = original;
  }
});

console.log(`\n${passed} mcp assertions passed.`);
