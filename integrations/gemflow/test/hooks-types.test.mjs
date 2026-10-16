import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The hooks module type-checks against the engine's declarations of the
// plugin API, with hooks/tsconfig.json. Claude Code lays the declarations in
// .claude-plugin/types/ when it loads the plugin from a folder it writes in;
// CLAUDE_CODE_TYPES may name a claude-code.d.ts instead (the plugin-authoring
// skill carries one). A clean checkout has neither, and the test says so.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONFIG = join(ROOT, "hooks", "tsconfig.json");
const LAID = join(ROOT, ".claude-plugin", "types", "claude-code", "index.d.ts");
const GIVEN = process.env["CLAUDE_CODE_TYPES"];

function skipReason() {
  if (existsSync(LAID)) return false;
  if (GIVEN === undefined || GIVEN === "") return "no plugin API declarations to check the hooks against: Claude Code lays them in .claude-plugin/types/ when it loads the plugin from a folder it writes in, or set CLAUDE_CODE_TYPES to a claude-code.d.ts";
  return existsSync(GIVEN) ? false : `CLAUDE_CODE_TYPES names ${GIVEN}, which does not exist`;
}

test("the hooks module type-checks against the plugin API", { skip: skipReason() }, (t) => {
  let project = CONFIG;
  if (!existsSync(LAID)) {
    // The hooks' own options, with the declarations named instead of the laid folder.
    const dir = mkdtempSync(join(tmpdir(), "gemflow-hooks-types-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    project = join(dir, "tsconfig.json");
    writeFileSync(project, JSON.stringify({ extends: CONFIG, include: [], files: [GIVEN, join(ROOT, "hooks", "register.tsx"), join(ROOT, "types", "index.d.ts")] }));
  }
  const r = spawnSync(process.execPath, [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", project], { encoding: "utf8" });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});
