import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { declaresMedia, mediaTodoCount } from "../dist/media-todo.js";
import { TODO_CAP } from "../dist/hosts/claude-code/protocol.js";
import { openWorkspace } from "../dist/workspace.js";
import { NO_TOOLS } from "../dist/core/host-tools.js";
import { BUNDLE, gitRepo, hook, withWorkflow } from "./helpers/repo.mjs";

const GEML = fileURLToPath(import.meta.resolve("@geml/geml/dist/cli.js"));
const DEV = fileURLToPath(new URL("../workflows/dev/", import.meta.url));
const EPISODE = [
  "=== meta", 'title   = "第 1 集"', 'profile = "geml-media/v1"', "===", "",
  "=== media-text {#s01 .prompt shot=1}", "清晨的码头，雾很浓。", "===", "",
  "=== media-text {#s02 .prompt shot=2}", "一只猫跳上船头。", "===", "",
  "=== data {#gen-log .gen-log format=jsonl}", "===", "",
].join("\n");

/** A project with the bundled video workflow active and episodes/ep01.geml: two shots, nothing generated yet. */
function videoProject() {
  const root = mkdtempSync(join(tmpdir(), "gemflow-todo-"));
  const init = spawnSync(process.execPath, [BUNDLE, "init", "--template", "video"], { cwd: root, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  mkdirSync(join(root, "episodes"));
  writeFileSync(join(root, "episodes", "ep01.geml"), EPISODE);
  return root;
}

test("a document declares geml-media when its meta's profile names it, alone or among others", () => {
  assert.equal(declaresMedia(EPISODE), true);
  assert.equal(declaresMedia('=== meta\nprofile = "geml-style/v1 geml-media/v1"\n===\n'), true);
  assert.equal(declaresMedia('=== meta\nprofile = "geml-statechart/v1"\n===\n'), false);
  assert.equal(declaresMedia("# 只是一份文档\n"), false);
});

test("the count is what geml media todo <file> --root <project> lists; a file that is no media entry, or is not there, has none", () => {
  const root = videoProject();
  const cli = spawnSync(process.execPath, [GEML, "media", "todo", "episodes/ep01.geml", "--root", ".", "--json"], { cwd: root, encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).length, 2);
  assert.equal(mediaTodoCount(root, "episodes/ep01.geml"), 2);
  writeFileSync(join(root, "episodes", "notes.geml"), "# 笔记\n");
  assert.equal(mediaTodoCount(root, "episodes/notes.geml"), undefined);
  assert.equal(mediaTodoCount(root, "episodes/missing.geml"), undefined);
});

test("a file-unit workspace names its work item's file, from the call or from the context document; a branch unit names none", () => {
  const root = videoProject();
  const given = openWorkspace({ root, tools: NO_TOOLS, lastFile: "episodes/ep01.geml" });
  assert.ok(given.ok);
  assert.deepEqual([given.ws.item, given.ws.itemFile], [{ kind: "item", id: "episodes/ep01" }, "episodes/ep01.geml"]);
  const remembered = openWorkspace({ root, tools: NO_TOOLS });
  assert.ok(remembered.ok);
  assert.equal(remembered.ws.itemFile, "episodes/ep01.geml");
  const repo = gitRepo();
  withWorkflow(repo, DEV, "dev");
  const branch = openWorkspace({ root: repo, tools: NO_TOOLS, gh: () => ({ available: false, reason: "not asked" }) });
  assert.ok(branch.ok);
  assert.deepEqual([branch.ws.item, branch.ws.itemFile], [{ kind: "item", id: "feat/x" }, undefined]);
});

test("an episode linked to a file outside the project has no count: the parser's confined host never reads it, so it is not a clean list", (t) => {
  const root = videoProject();
  const outside = mkdtempSync(join(tmpdir(), "gemflow-todo-outside-"));
  writeFileSync(join(outside, "ep.geml"), EPISODE);
  try {
    symlinkSync(join(outside, "ep.geml"), join(root, "episodes", "linked.geml"));
  } catch (err) {
    // Windows makes a file link only with the privilege or developer mode: without it there is no link to judge.
    if (err.code === "EPERM") return t.skip("this account may not make a file link");
    throw err;
  }
  assert.equal(mediaTodoCount(root, "episodes/linked.geml"), undefined);
  assert.equal(hook(root, { op: "refresh", lastFile: "episodes/linked.geml" }).todo, null);
});

test("the count stops past the cap, and a count that runs over its time budget is none", () => {
  const root = videoProject();
  const shots = Array.from({ length: TODO_CAP + 300 }, (_, i) => `=== media-text {#s${i} .prompt shot=${i}}\n雾。\n===\n`).join("\n");
  writeFileSync(join(root, "episodes", "big.geml"), '=== meta\nprofile = "geml-media/v1"\n===\n\n' + shots);
  assert.equal(TODO_CAP, 999);
  assert.equal(mediaTodoCount(root, "episodes/big.geml"), TODO_CAP + 1, "more than the cap reads cap + 1");
  assert.equal(mediaTodoCount(root, "episodes/ep01.geml", { budgetMs: 0 }), undefined);
  assert.equal(mediaTodoCount(root, "episodes/ep01.geml", { budgetMs: 60_000 }), 2);
});

test("refresh and board carry the work item's to-do count and the stage it was read in; other ops leave it out; a work item that is no media entry has none", () => {
  const root = videoProject();
  assert.equal(hook(root, { op: "status", lastFile: "episodes/ep01.geml" }).todo, undefined);
  assert.deepEqual(hook(root, { op: "refresh" }).todo, { item: "episodes/ep01", state: "script", count: 2 });
  assert.deepEqual(hook(root, { op: "board" }).todo, { item: "episodes/ep01", state: "script", count: 2 });
  writeFileSync(join(root, "episodes", "ep02.geml"), '=== meta\ntitle = "第 2 集"\n===\n');
  assert.equal(hook(root, { op: "refresh", lastFile: "episodes/ep02.geml" }).todo, null);
});
