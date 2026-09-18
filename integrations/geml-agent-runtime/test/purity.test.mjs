import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const core = new URL("../src/core/", import.meta.url);
const sources = (dir) =>
  readdirSync(dir)
    .filter((n) => n.endsWith(".ts"))
    .map((n) => [n, readFileSync(new URL(n, dir), "utf8")]);

test("src/core/* imports no fs/process/child_process and never touches process or console", () => {
  for (const [f, src] of sources(core)) {
    assert.doesNotMatch(src, /from "node:(fs|process|child_process)"/, `${f} imports a host module`);
    assert.doesNotMatch(src, /\bprocess\.|\bconsole\./, `${f} touches process or console`);
  }
});

test("src/core/* names no host: the supervisor must not know who it is mounted on", () => {
  for (const [f, src] of sources(core)) {
    assert.doesNotMatch(src, /@deepseek-ai|@earendil-works|from "typebox"/, `${f} imports a host package`);
  }
});

// Each adapter statically imports its own host's packages, and those are
// OPTIONAL peers: an install with only one harness must never resolve the
// other one's modules. Crossing this line does not fail the build - it fails
// at the user's first import, which is why it is a test.
test("the two adapters do not reach into each other's host", () => {
  for (const [f, src] of sources(new URL("../src/hosts/dsh/", import.meta.url))) {
    assert.doesNotMatch(src, /@earendil-works|from "typebox"/, `dsh/${f} imports a Pi package`);
  }
  for (const [f, src] of sources(new URL("../src/hosts/pi/", import.meta.url))) {
    assert.doesNotMatch(src, /@deepseek-ai/, `pi/${f} imports a DSH package`);
  }
});

test("the package entry point pulls in neither host", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /@deepseek-ai|@earendil-works|hosts\//, "the root must resolve with no harness installed");
});
