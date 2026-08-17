// `geml skill install`: the best-effort halves — putting the CLI on the global
// PATH, and registering the MCP server — exercised through a FAKE PATH.
//
// These branches are the installer's whole value on a fresh machine, and they
// were the largest uncovered region in the parser: the existing suite runs with
// --no-global --no-mcp, so every spawn below never happened. Rather than mock
// the module, each case puts a shim named `npm` / `claude` / `geml` first on
// PATH and asserts what the installer REPORTS — the same contract a user sees.
//
// Shims are written for both worlds: a `.cmd` for Windows (cmd.exe resolves
// .cmd via PATHEXT) and an extensionless POSIX script with a shebang, chmod +x.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as presolve, delimiter } from "node:path";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const CLI = presolve("dist/geml.js");
const WIN = process.platform === "win32";
// The installer keeps the global CLI in step with the skill text it just wrote,
// so "already installed" means THIS package's version — read it from the source
// of truth rather than pinning a literal that every release would invalidate.
const PKG_VERSION = JSON.parse(readFileSync(presolve("package.json"), "utf8")).version;
// The skill text as the installer will write it: the packaged file minus its
// Claude-only frontmatter. Read from the source of truth so a rewrite of the
// skill cannot quietly stop being checked.
const PACKAGED_BODY = readFileSync(presolve("skill/SKILL.md"), "utf8")
  .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, "").trimEnd();

// A shim that prints `out` and exits `code`. `name` is the command word the
// installer spawns; on Windows the .cmd is what resolves, elsewhere the
// extensionless script does.
function shim(dir, name, code, out = "") {
  if (WIN) {
    writeFileSync(join(dir, `${name}.cmd`), `@echo off\r\n${out ? `echo ${out}\r\n` : ""}exit /b ${code}\r\n`);
  }
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${out ? `echo "${out}"\n` : ""}exit ${code}\n`);
  try { chmodSync(p, 0o755); } catch { /* best effort */ }
}

// A shim that succeeds and echoes the argv it was handed, so a test can assert
// WHAT was asked of npm — the pinned `@geml/geml@<version>` spec, not just that
// something ran. The installer spawns npm with stdio inherit, so this lands on
// the captured stdout.
function echoArgsShim(dir, name) {
  if (WIN) writeFileSync(join(dir, `${name}.cmd`), "@echo off\r\necho %*\r\nexit /b 0\r\n");
  const p = join(dir, name);
  writeFileSync(p, '#!/bin/sh\necho "$@"\nexit 0\n');
  try { chmodSync(p, 0o755); } catch { /* best effort */ }
}

// A shim whose exit code depends on its FIRST argument, so one `claude` can be
// "found, but this subcommand fails" — which is how the real flow branches
// (`--version` ok, `mcp get` fails, `mcp add` succeeds).
function argShim(dir, name, rules, fallback = 1) {
  const winBody = rules.map(([arg, code]) => `if "%1"=="${arg}" exit /b ${code}`).join("\r\n");
  if (WIN) writeFileSync(join(dir, `${name}.cmd`), `@echo off\r\n${winBody}\r\nexit /b ${fallback}\r\n`);
  const shBody = rules.map(([arg, code]) => `[ "$1" = "${arg}" ] && exit ${code}`).join("\n");
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${shBody}\nexit ${fallback}\n`);
  try { chmodSync(p, 0o755); } catch { /* best effort */ }
}

// Run the installer with `binDir` FIRST on PATH, always into a throwaway dest.
function install(binDir, extraArgs = []) {
  const dest = mkdtempSync(join(tmpdir(), "geml-inst-"));
  const r = spawnSync(process.execPath, [CLI, "skill", "install", "--dest", dest, ...extraArgs], {
    encoding: "utf8",
    timeout: 60_000,
    // An empty home as well as a fake PATH: detection must not reach the
    // developer's real ~/.gemini, and these assertions must not depend on it.
    env: { ...process.env, HOME: dest, USERPROFILE: dest, PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`, Path: `${binDir}${delimiter}${process.env.Path ?? ""}` },
  });
  rmSync(dest, { recursive: true, force: true });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

function bin() {
  const d = mkdtempSync(join(tmpdir(), "geml-bin-"));
  mkdirSync(d, { recursive: true });
  return d;
}

test("cli step: the MATCHING geml already on PATH is reported, not reinstalled", () => {
  const d = bin();
  shim(d, "geml", 0, `geml ${PKG_VERSION} (GEML spec 1.0)`);
  shim(d, "npm", 1); // would fail if it were called — proving it is not
  const r = install(d, ["--no-mcp"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /already on PATH/);
  assert.doesNotMatch(r.out, /installing @geml\/geml globally/, "no install attempted");
  rmSync(d, { recursive: true, force: true });
});

test("cli step: a STALE geml on PATH is upgraded, pinned to the skill's own version", () => {
  const d = bin();
  // A version that can never be this package's own, so the case stays a
  // mismatch for every future release.
  shim(d, "geml", 0, "geml 0.0.1 (GEML spec 1.0)");
  echoArgsShim(d, "npm");
  const r = install(d, ["--no-mcp"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /installing @geml\/geml globally/);
  assert.match(r.out, new RegExp(`0\\.0\\.1 -> ${PKG_VERSION.replace(/\./g, "\\.")}`), "says what it is changing");
  // The spec is PINNED, not @latest: the point is to land the version whose
  // skill text was just written, even when npm's latest has moved past it.
  assert.match(r.out, new RegExp(`install -g @geml/geml@${PKG_VERSION.replace(/\./g, "\\.")}`));
  assert.doesNotMatch(r.out, /already on PATH/);
  rmSync(d, { recursive: true, force: true });
});

test("cli step: a geml on PATH that prints no version at all counts as a mismatch", () => {
  const d = bin();
  shim(d, "geml", 0, "some other geml"); // exit 0, nothing parseable
  echoArgsShim(d, "npm");
  const r = install(d, ["--no-mcp"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /installing @geml\/geml globally/);
  assert.doesNotMatch(r.out, /already on PATH/);
  rmSync(d, { recursive: true, force: true });
});

test("cli step: geml absent and the global install fails — the fallback command is printed, exit stays 0", () => {
  const d = bin();
  shim(d, "geml", 1);
  shim(d, "npm", 1);
  const r = install(d, ["--no-mcp"]);
  assert.equal(r.code, 0, "a best-effort step never fails the install");
  assert.match(r.out, /installing @geml\/geml globally/);
  assert.match(r.out, /global install failed .* npm i -g @geml\/geml/s);
  rmSync(d, { recursive: true, force: true });
});

test("cli step: geml absent and the global install succeeds — no failure line", () => {
  const d = bin();
  shim(d, "geml", 1);
  shim(d, "npm", 0);
  const r = install(d, ["--no-mcp"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /installing @geml\/geml globally/);
  assert.doesNotMatch(r.out, /global install failed/);
  rmSync(d, { recursive: true, force: true });
});

test("mcp step: no claude CLI — the registration command is handed over verbatim", () => {
  const d = bin();
  shim(d, "claude", 1);
  const r = install(d, ["--no-global"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /claude CLI not found/);
  assert.match(r.out, /claude mcp add --scope user geml -- npx -y @geml\/geml mcp --root \./);
  rmSync(d, { recursive: true, force: true });
});

test("mcp step: an already-registered server is left alone", () => {
  const d = bin();
  // --version ok, `mcp get` ok  => already registered, nothing added
  argShim(d, "claude", [["--version", 0], ["mcp", 0]]);
  const r = install(d, ["--no-global"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /already registered/);
  assert.doesNotMatch(r.out, /registered user-scope/, "no add attempted");
  rmSync(d, { recursive: true, force: true });
});

test("mcp step: registration failure reports the reason and the manual command", () => {
  const d = bin();
  // --version ok; every `mcp` subcommand fails => `get` misses, `add` fails
  argShim(d, "claude", [["--version", 0]], 1);
  const r = install(d, ["--no-global"]);
  assert.equal(r.code, 0, "still not fatal");
  assert.match(r.out, /registration failed/);
  assert.match(r.out, /claude mcp add --scope user geml/);
  rmSync(d, { recursive: true, force: true });
});

// --- other agent tools: detect, never create; one failure never stops the rest
//
// Every case below redirects HOME/USERPROFILE at spawn, so the suite can never
// touch the developer's real ~/.gemini — os.homedir() reads those variables on
// every platform, which is also why no --home flag was needed.

function homeRun(home, cwd, extra = []) {
  const dest = join(home, ".claude", "skills");
  const r = spawnSync(process.execPath, [CLI, "skill", "install", "--dest", dest, "--no-global", "--no-mcp", ...extra], {
    cwd, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "geml-tools-"));
  mkdirSync(join(root, "home"), { recursive: true });
  mkdirSync(join(root, "proj"), { recursive: true });
  return { root, home: join(root, "home"), proj: join(root, "proj") };
}

test("a tool that is not installed is skipped by name — and its directory is never created", () => {
  const { root, home, proj } = sandbox();
  const r = homeRun(home, proj);
  assert.equal(r.code, 0);
  assert.match(r.out, /gemini not detected/);
  assert.match(r.out, /qwen\s+not detected/);
  assert.match(r.out, /agents-md not detected/);
  assert.equal(existsSync(join(home, ".gemini")), false, "no tool directory conjured up");
  rmSync(root, { recursive: true, force: true });
});

test("a detected tool gets the skill block, and the file's own content survives", () => {
  const { root, home, proj } = sandbox();
  mkdirSync(join(home, ".gemini"), { recursive: true });
  writeFileSync(join(home, ".gemini", "GEMINI.md"), "# My rules\n\nAlways use tabs.\n");
  assert.equal(homeRun(home, proj).code, 0);
  const after = readFileSync(join(home, ".gemini", "GEMINI.md"), "utf8");
  assert.match(after, /Always use tabs\./, "what the person wrote is still there");
  assert.match(after, /geml:skill:start/);
  // Compare against the PACKAGED text rather than one sentence out of it.
  // Matching a heading meant that rewording the heading read as "the skill did
  // not land", and it could not tell a whole file from its first line. Split on
  // `<skill-base>`, which the installer rewrites to wherever the reference
  // document went, and require every piece between those seams.
  for (const chunk of PACKAGED_BODY.split("<skill-base>")) {
    assert.ok(after.includes(chunk), "the packaged skill text landed whole");
  }
  assert.doesNotMatch(after, /^---\r?\nname: geml/m, "Claude-only frontmatter is stripped");
  rmSync(root, { recursive: true, force: true });
});

test("a re-run refreshes the block in place — never a second copy", () => {
  const { root, home, proj } = sandbox();
  mkdirSync(join(home, ".gemini"), { recursive: true });
  writeFileSync(join(home, ".gemini", "GEMINI.md"), "# Mine\n");
  homeRun(home, proj);
  const once = readFileSync(join(home, ".gemini", "GEMINI.md"), "utf8");
  const again = homeRun(home, proj);
  assert.match(again.out, /gemini already current/);
  assert.equal(readFileSync(join(home, ".gemini", "GEMINI.md"), "utf8"), once, "byte-identical, no growth");
  assert.equal((once.match(/geml:skill:start/g) ?? []).length, 1, "exactly one block");
  rmSync(root, { recursive: true, force: true });
});

test("AGENTS.md is joined only where one already exists — the project file is never started", () => {
  const { root, home, proj } = sandbox();
  assert.match(homeRun(home, proj).out, /agents-md not detected/);
  assert.equal(existsSync(join(proj, "AGENTS.md")), false);
  writeFileSync(join(proj, "AGENTS.md"), "# House rules\n");
  assert.match(homeRun(home, proj).out, /agents-md added/);
  assert.match(readFileSync(join(proj, "AGENTS.md"), "utf8"), /House rules[\s\S]*geml:skill:start/);
  rmSync(root, { recursive: true, force: true });
});

test("--dry-run reports every target and writes nothing", () => {
  const { root, home, proj } = sandbox();
  mkdirSync(join(home, ".gemini"), { recursive: true });
  writeFileSync(join(proj, "AGENTS.md"), "# House rules\n");
  const r = homeRun(home, proj, ["--dry-run"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /would install/);
  assert.match(r.out, /gemini would add/);
  assert.match(r.out, /agents-md would add/);
  assert.equal(existsSync(join(home, ".gemini", "GEMINI.md")), false, "nothing written");
  assert.doesNotMatch(readFileSync(join(proj, "AGENTS.md"), "utf8"), /geml:skill/);
  rmSync(root, { recursive: true, force: true });
});

test("one unwritable target is reported and the others still install", () => {
  // Portable way to make exactly one write fail on every OS: put a FILE where
  // the target expects a directory, so the write is ENOTDIR/EEXIST. chmod would
  // not do it — it is a no-op for the owner on Windows.
  const { root, home, proj } = sandbox();
  mkdirSync(join(home, ".gemini"), { recursive: true });
  mkdirSync(join(home, ".qwen", "QWEN.md"), { recursive: true }); // a directory named like the file
  writeFileSync(join(proj, "AGENTS.md"), "# House rules\n");
  const r = homeRun(home, proj);
  assert.equal(r.code, 0, "a partial install is still an install");
  assert.match(r.out, /qwen\s+could not update/, "the failure is named");
  assert.match(r.out, /gemini added/, "the others carried on");
  assert.match(r.out, /agents-md added/);
  assert.match(r.out, /1 skipped after an error/, "the summary counts it");
  rmSync(root, { recursive: true, force: true });
});

test("when nothing can be installed the exit code says so", () => {
  const { root, home, proj } = sandbox();
  // The skill destination itself is unwritable, and no other tool is present.
  const dest = join(home, "not-a-dir");
  writeFileSync(dest, "x");
  const r = spawnSync(process.execPath, [CLI, "skill", "install", "--dest", dest, "--no-global", "--no-mcp"], {
    cwd: proj, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  assert.equal(r.status, 1, "total failure is the one case a caller must react to");
  assert.match((r.stdout ?? "") + (r.stderr ?? ""), /nothing was installed/);
  rmSync(root, { recursive: true, force: true });
});

console.log(`cov-installer: ${passed} passed`);
