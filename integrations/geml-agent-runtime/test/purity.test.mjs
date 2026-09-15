import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const dir = new URL("../src/core/", import.meta.url);
test("src/core/* imports no fs/process/child_process and never touches process or console", () => {
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
    const src = readFileSync(new URL(f, dir), "utf8");
    assert.doesNotMatch(src, /from "node:(fs|process|child_process)"/, `${f} imports a host module`);
    assert.doesNotMatch(src, /\bprocess\.|\bconsole\./, `${f} touches process or console`);
  }
});
