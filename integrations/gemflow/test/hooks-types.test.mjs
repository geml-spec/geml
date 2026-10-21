import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The hooks module type-checks against the engine's declarations of the
// plugin API, with hooks/tsconfig.json. No package ships them: Claude Code
// writes them itself, into .claude-plugin/types/ when it loads the plugin from
// a folder it writes in, and into its temp folder's
// claude-<user>/bundled-skills/<build>/<hash>/plugin-authoring/types/claude-code.d.ts
// each time the plugin-authoring skill loads. The newest of those is checked
// against (a laid folder stays as old as the last load from this checkout);
// CLAUDE_CODE_TYPES names a claude-code.d.ts that wins over both. A machine
// with none fails, saying how to get one: a check that skipped is how type
// errors reached the branch. Only CI, which has no Claude Code, skips it.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONFIG = join(ROOT, "hooks", "tsconfig.json");
const LAID = join(ROOT, ".claude-plugin", "types", "claude-code", "index.d.ts");
const GIVEN = process.env["CLAUDE_CODE_TYPES"];
const MISSING = "no plugin API declarations on this machine to check the hooks against: load the plugin-authoring skill once in a Claude Code session (it writes them under its temp folder's bundled-skills/), or set CLAUDE_CODE_TYPES to a claude-code.d.ts";

/** The plugin-authoring skill's copies of the declarations, under Claude Code's temp folders. */
function skillCopies() {
  const list = (dir) => { try { return readdirSync(dir); } catch { return []; } };
  const found = [];
  for (const base of new Set(["/tmp", tmpdir()])) {
    for (const own of list(base).filter((n) => n.startsWith("claude-"))) {
      const skills = join(base, own, "bundled-skills");
      for (const build of list(skills)) for (const hash of list(join(skills, build))) {
        const file = join(skills, build, hash, "plugin-authoring", "types", "claude-code.d.ts");
        if (existsSync(file)) found.push(file);
      }
    }
  }
  return found;
}

/** The declarations to check against, and whether they are the laid folder; null when this machine has none. */
function declarations() {
  if (GIVEN !== undefined && GIVEN !== "") return { file: GIVEN, laid: false };
  const candidates = [...(existsSync(LAID) ? [LAID] : []), ...skillCopies()];
  if (candidates.length === 0) return null;
  const newest = candidates.reduce((a, b) => (statSync(b).mtimeMs > statSync(a).mtimeMs ? b : a));
  return { file: newest, laid: newest === LAID };
}

const found = declarations();

test("the hooks module type-checks against the plugin API", { skip: found === null && process.env["CI"] ? `${MISSING} (CI has no Claude Code)` : false }, (t) => {
  assert.ok(found !== null, MISSING);
  assert.ok(existsSync(found.file), `CLAUDE_CODE_TYPES names ${found.file}, which does not exist`);
  t.diagnostic(`checked against ${found.file}`);
  let project = CONFIG;
  if (!found.laid) {
    // The hooks' own options, with the declarations named instead of the laid folder.
    const dir = mkdtempSync(join(tmpdir(), "gemflow-hooks-types-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    project = join(dir, "tsconfig.json");
    writeFileSync(project, JSON.stringify({ extends: CONFIG, include: [], files: [found.file, join(ROOT, "hooks", "register.tsx"), join(ROOT, "types", "index.d.ts")] }));
  }
  const r = spawnSync(process.execPath, [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", project], { encoding: "utf8" });
  assert.equal(r.status, 0, `checked against ${found.file}\n${r.stdout}${r.stderr}`);
});
