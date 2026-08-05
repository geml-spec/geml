// `geml skill install`: the one-command Claude Code setup. These tests pin
// the file-drop contract (skill lands under <dest>/geml, matches the bundled
// source byte-for-byte, never ships a .gemlhistory, idempotent re-run) and
// the usage/help behaviour. --no-global/--no-mcp keep the tests hermetic:
// no npm -g, no claude CLI, no network.
import { spawnSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

function run(args) {
  const r = spawnSync(process.execPath, ["dist/geml.js", ...args], { encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const dest = mkdtempSync(join(tmpdir(), "geml-skill-"));

test("skill install drops SKILL.md + references under <dest>/geml and exits 0", () => {
  const r = run(["skill", "install", "--dest", dest, "--no-global", "--no-mcp"]);
  assert.equal(r.code, 0, r.err);
  assert.ok(existsSync(join(dest, "geml", "SKILL.md")));
  assert.ok(existsSync(join(dest, "geml", "references", "authoring.geml")));
  assert.match(r.out, /skill\s+installed/);
});

test("installed files match the bundled skill byte-for-byte", () => {
  for (const rel of [["SKILL.md"], ["references", "authoring.geml"]]) {
    assert.equal(
      readFileSync(join(dest, "geml", ...rel), "utf8"),
      readFileSync(join("skill", ...rel), "utf8"),
    );
  }
});

test("re-run is idempotent and never ships a history sidecar", () => {
  // A sidecar sitting next to the bundled source must NOT be copied: skill
  // and config docs carry no .gemlhistory (git is their history).
  writeFileSync(join("skill", "references", "authoring.gemlhistory"), "stray\n");
  try {
    const r = run(["skill", "install", "--dest", dest, "--no-global", "--no-mcp"]);
    assert.equal(r.code, 0, r.err);
    assert.ok(!existsSync(join(dest, "geml", "references", "authoring.gemlhistory")));
  } finally {
    rmSync(join("skill", "references", "authoring.gemlhistory"), { force: true });
  }
});

test("the installed reference doc parses clean (geml check exit 0)", () => {
  const r = run(["check", join(dest, "geml", "references", "authoring.geml")]);
  assert.equal(r.code, 0, r.err);
});

test("every in-repo skill copy is identical to the packaged skill (no drift)", () => {
  // Three copies of one text: the packaged source (skill/), the plugin's
  // (integrations/claude-plugin), and the repo's own dogfood copy (.claude).
  const copies = [
    join("..", "integrations", "claude-plugin", "skills", "geml"),
    join("..", ".claude", "skills", "geml"),
  ];
  // Newlines normalized: git's autocrlf may check the copies out with
  // different endings on Windows — the guard is about CONTENT drift.
  const norm = (s) => s.replace(/\r\n/g, "\n");
  for (const dir of copies) {
    for (const rel of [["SKILL.md"], ["references", "authoring.geml"]]) {
      assert.equal(
        norm(readFileSync(join(dir, ...rel), "utf8")),
        norm(readFileSync(join("skill", ...rel), "utf8")),
        `${dir} drifted from geml-parser/skill (${rel.join("/")}) — re-copy the packaged file`,
      );
    }
  }
});

test("a dest that cannot be created fails clean (exit 1, no stack trace)", () => {
  // --dest pointing THROUGH a plain file: mkdir must fail, and the failure
  // must be the CLI's one-line error, never a raw Node stack.
  const file = join(dest, "not-a-dir");
  writeFileSync(file, "plain file\n");
  const r = run(["skill", "install", "--dest", join(file, "sub"), "--no-global", "--no-mcp"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /cannot install skill to /);
  assert.doesNotMatch(r.err, /\n\s+at /, "stack trace leaked to stderr");
});

test("unknown subcommand is a usage error (exit 2) naming the usage", () => {
  const r = run(["skill", "bogus"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown skill subcommand/);
});

test("skill --help exits 0 and documents the flags", () => {
  const r = run(["skill", "--help"]);
  assert.equal(r.code, 0);
  for (const f of ["--dest", "--no-global", "--no-mcp"]) assert.match(r.out, new RegExp(f));
});

rmSync(dest, { recursive: true, force: true });
console.log(`skill-install: ${passed} passed`);
