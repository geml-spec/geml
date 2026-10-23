// The project's Claude Code memory as the board reads and edits it, on a folder of its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteMemory, memoryDir, readMemory, setMemoryHook } from "../dist/memory-store.js";

/** A memory folder of three entries, the index in the line ending given. */
function folder(nl = "\n") {
  const dir = mkdtempSync(join(tmpdir(), "gf-memory-"));
  const one = (file, type, at) => {
    writeFileSync(join(dir, file), `---\nname: ${file}\ndescription: x\nmetadata:\n  type: ${type}\n---\n\nbody of ${file}\n`);
    utimesSync(join(dir, file), at, at);
  };
  one("a.md", "feedback", new Date("2026-10-20T00:00:00Z"));
  one("b.md", "project", new Date("2026-10-22T00:00:00Z"));
  one("c.md", "reference", new Date("2026-10-21T00:00:00Z"));
  writeFileSync(join(dir, "MEMORY.md"), ["- [甲](a.md) — 第一条", "- [乙](b.md) — 第二条", "- [丙](c.md) - 第三条", ""].join(nl));
  return { dir, trash: join(dir, "..", `${dir.split(/[\\/]/).pop()}-trash`) };
}

test("memory: the folder is the projects folder, then the project's path with every other character a dash, then memory", () => {
  assert.equal(memoryDir("/h/projects", "C:\\agentProjects\\geml-spec"), join("/h/projects", "C--agentProjects-geml-spec", "memory"));
  assert.equal(memoryDir("/h/projects", "/Users/me/my.app"), join("/h/projects", "-Users-me-my-app", "memory"));
});

test("memory: the index's entries with their type from the front matter, the newest first; a missing index is none", () => {
  const { dir } = folder();
  const m = readMemory(dir);
  assert.deepEqual(m.entries.map((e) => [e.file, e.title, e.hook, e.type]), [["b.md", "乙", "第二条", "project"], ["c.md", "丙", "第三条", "reference"], ["a.md", "甲", "第一条", "feedback"]]);
  assert.deepEqual(readMemory(join(dir, "none")).entries, []);
});

test("memory: a new hook rewrites its one index line, the line ending and the others kept, the index copied to the trash first; nothing outside the folder, no line break", () => {
  const { dir, trash } = folder("\r\n");
  assert.equal(setMemoryHook(dir, "b.md", "  改过的第二条  ", trash), true);
  assert.equal(readFileSync(join(dir, "MEMORY.md"), "utf8"), ["- [甲](a.md) — 第一条", "- [乙](b.md) — 改过的第二条", "- [丙](c.md) - 第三条", ""].join("\r\n"));
  assert.ok(readFileSync(join(trash, "MEMORY.md"), "utf8").includes("— 第二条"), "the index as it was, in the trash");
  for (const file of ["../b.md", "MEMORY.md", "x.md", "a.txt"]) assert.equal(setMemoryHook(dir, file, "y", trash), false, file);
  assert.equal(setMemoryHook(dir, "a.md", "两行\n不行", trash), false);
  assert.equal(setMemoryHook(dir, "a.md", "   ", trash), false);
});

test("memory: a delete moves the file into the trash and drops its index line; a file the index does not list is left alone", () => {
  const { dir, trash } = folder();
  assert.equal(deleteMemory(dir, "a.md", trash), true);
  assert.ok(!existsSync(join(dir, "a.md")) && existsSync(join(trash, "a.md")), "moved, not deleted");
  assert.deepEqual(readMemory(dir).entries.map((e) => e.file), ["b.md", "c.md"]);
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "loose.md"), "not listed");
  assert.equal(deleteMemory(dir, "loose.md", trash), false);
  assert.ok(existsSync(join(dir, "loose.md")));
  assert.equal(deleteMemory(dir, "../c.md", trash), false);
});
