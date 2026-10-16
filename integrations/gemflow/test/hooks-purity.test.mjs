import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The hooks module runs inside Claude Code with no Node and no DOM, and loads
// only files it reaches by static relative import. This walks that closure
// from hooks/*.tsx through the dist/ files it imports.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOOKS = resolve(ROOT, "hooks");
// A static import or re-export; group 1 is `type` (erased before the module runs), group 2 the specifier.
const STATIC = /^[ \t]*(?:import|export)[ \t]+(type[ \t]+)?(?:[\w*${}\s,]+?\s+from\s+)?["']([^"']+)["'][ \t]*;?[ \t]*$/gm;
const NODE_GLOBAL = /(?<![.\w$])(?:process\.\w|Buffer\b|__dirname\b|__filename\b|require\s*\(|setImmediate\b)|\bglobalThis\.(?:process|Buffer|setImmediate)\b|\bimport\.meta\.(?:dirname|filename)\b/;

function closure(entry) {
  const files = new Map();
  const todo = [entry];
  while (todo.length > 0) {
    const file = todo.pop();
    if (files.has(file)) continue;
    assert.ok(existsSync(file), `${relative(ROOT, file)} is imported but missing (run npm run build)`);
    const src = readFileSync(file, "utf8");
    const specs = [...src.matchAll(STATIC)].filter((m) => !m[1]).map((m) => m[2]);
    files.set(file, { src, specs });
    for (const s of specs) if (s.startsWith(".")) todo.push(resolve(dirname(file), s));
  }
  return files;
}

test("the Node-global guard catches the globals, globalThis's way to them, import.meta's paths and setImmediate", () => {
  for (const src of [
    "process.env.X", "Buffer.from(x)", "__dirname", "__filename", "require('fs')", "globalThis.process.env", "globalThis.Buffer.from(x)",
    "import.meta.dirname", "import.meta.filename", "setImmediate(f)", "globalThis.setImmediate(f)", "const { env } = globalThis.process",
  ]) assert.match(src, NODE_GLOBAL, src);
  for (const src of ["x.process.y", "myBuffer", "import.meta.url", "setTimeout(f)", "processed", "$.process.run(x)"]) assert.doesNotMatch(src, NODE_GLOBAL, src);
});

test("the hooks module and everything it imports run without Node", () => {
  const entries = readdirSync(HOOKS).filter((n) => /\.(?:tsx?|jsx?|mjs)$/.test(n)).map((n) => resolve(HOOKS, n));
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    for (const [file, { src, specs }] of closure(entry)) {
      const name = relative(ROOT, file);
      for (const s of specs) {
        if (s.startsWith(".")) continue;
        assert.ok(dirname(file) === HOOKS && s === "claude-code", `${name} imports "${s}": only the hooks module may import bare, and only the engine's 'claude-code'`);
      }
      assert.doesNotMatch(src, /\bimport\s*\(/, `${name} holds import(), which the engine refuses to load`);
      assert.doesNotMatch(src, NODE_GLOBAL, `${name} reaches for a Node global`);
    }
  }
});
