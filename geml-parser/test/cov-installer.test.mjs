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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as presolve, delimiter } from "node:path";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const CLI = presolve("dist/geml.js");
const WIN = process.platform === "win32";

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
    env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`, Path: `${binDir}${delimiter}${process.env.Path ?? ""}` },
  });
  rmSync(dest, { recursive: true, force: true });
  return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

function bin() {
  const d = mkdtempSync(join(tmpdir(), "geml-bin-"));
  mkdirSync(d, { recursive: true });
  return d;
}

test("cli step: a geml already on PATH is reported, not reinstalled", () => {
  const d = bin();
  shim(d, "geml", 0, "geml 9.9.9 (GEML spec 1.0)");
  shim(d, "npm", 1); // would fail if it were called — proving it is not
  const r = install(d, ["--no-mcp"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /already on PATH/);
  assert.doesNotMatch(r.out, /installing @geml\/geml globally/, "no install attempted");
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

console.log(`cov-installer: ${passed} passed`);
