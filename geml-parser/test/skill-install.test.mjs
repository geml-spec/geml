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

// Every run gets an EMPTY home. The installer also writes to whatever agent
// tools it detects there, so a real `~/.gemini` would both touch the
// developer's own machine and make these results depend on which tools they
// happen to have installed.
const HOME_DIR = mkdtempSync(join(tmpdir(), "geml-home-"));
function run(args) {
  const r = spawnSync(process.execPath, ["dist/geml.js", ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, HOME: HOME_DIR, USERPROFILE: HOME_DIR },
  });
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
  // Six copies of one text: the packaged source (skill/), one per harness
  // plugin (claude, codex, dsh, grok), and the repo's own dogfood copy
  // (.claude). Every new harness adds a copy, so every new harness belongs in
  // this list — dsh's sat outside it and happened not to drift, which is luck,
  // not a guarantee.
  const copies = [
    join("..", "integrations", "claude-plugin", "skills", "geml"),
    join("..", "integrations", "codex-plugin", "skills", "geml"),
    join("..", "integrations", "dsh-plugin", "skills", "geml"),
    join("..", "integrations", "grok-plugin", "skills", "geml"),
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

test("the harness plugins ship the same payload (no drift between them)", () => {
  // The code-graph skill and the SessionStart hook have no copy under skill/:
  // they exist only inside the plugins, so the pin is plugin-against-plugin.
  // The hook body is harness-agnostic on purpose — Codex's SessionStart
  // contract is the same JSON in, `hookSpecificOutput` out, exit 0 — so only
  // the manifests differ, and a reworded hook here means one harness silently
  // stopped saying what the other says.
  const norm = (s) => s.replace(/\r\n/g, "\n");
  // Only Codex is pinned on the hook: dsh and grok ship no hooks directory,
  // deliberately — neither harness's SessionStart contract has been verified
  // here, and a hook that silently never fires is worse than none.
  const claude = join("..", "integrations", "claude-plugin");
  for (const [dir, rels] of [
    ["codex-plugin", [["skills", "geml-code-graph", "SKILL.md"], ["hooks", "inject-trigger.mjs"], ["LICENSE"]]],
    ["dsh-plugin", [["skills", "geml-code-graph", "SKILL.md"], ["LICENSE"]]],
    ["grok-plugin", [["skills", "geml-code-graph", "SKILL.md"], ["LICENSE"]]],
  ]) {
    for (const rel of rels) {
      assert.equal(
        norm(readFileSync(join("..", "integrations", dir, ...rel), "utf8")),
        norm(readFileSync(join(claude, ...rel), "utf8")),
        `${dir}/${rel.join("/")} drifted from claude-plugin's — copy one over the other`,
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
  assert.match(r.err, /could not install to /);
  assert.match(r.err, /nothing was installed/, "with no other tool present, that is a total failure");
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
