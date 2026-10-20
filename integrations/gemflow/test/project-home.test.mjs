// Where a project keeps its workflows, dictionary and project document: one
// file per workflow in the home (the main working tree), the earlier layout
// still read and moved into it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  dictionaryPathOf, GITIGNORE, installedWorkflows, mergedWorkflow, mergeTools, migrateLayout, projectDocOf, recordedPath, workflowAt, workflowNameOf,
} from "../dist/project-home.js";
import { journalBaseOf } from "../dist/host-git.js";
import { readDictionary } from "../dist/core/dictionary-file.js";
import { loadStatechart } from "../dist/core/statechart.js";
import { addWorkflow, importWorkflow, useWorkflow } from "../dist/project.js";
import { openWorkspace, resolvePromptRef, resolveWorkflow } from "../dist/workspace.js";
import { NO_TOOLS } from "../dist/core/host-tools.js";
import { realPath } from "../dist/host-fs.js";
import { gitRepo, withWorkflow } from "./helpers/repo.mjs";

const tmp = () => realPath(mkdtempSync(join(tmpdir(), "gemflow-home-")));
const DEV = fileURLToPath(new URL("../workflows/dev/", import.meta.url));
const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
// gh is never asked here: the item and its workflow are what is under test.
const NO_GH = () => ({ available: false, reason: "gh is not installed" });
const git = (root, ...a) => spawnSync("git", ["-C", root, ...a], { encoding: "utf8" });

test("a workflow directory as one file: the guide's sections after the statechart, each ./guide.geml#id now #id, and every stage still finds its text", () => {
  const m = mergedWorkflow("dev", read(join(DEV, "flow.geml")), (f) => (existsSync(join(DEV, f)) ? read(join(DEV, f)) : undefined));
  assert.equal(m.extra.size, 0, "the guide is taken in, nothing beside the file");
  assert.doesNotMatch(m.text, /guide\.geml/, "no reference to the guide is left");
  assert.match(m.text, /"prompt": "#build"/);
  assert.match(m.text, /^# 构建 \{#build\}$/m, "the guide's sections are in the file");
  assert.doesNotMatch(m.text, /各阶段说明/, "the guide's own meta is not");
  const root = tmp();
  const file = join(root, ".geml", "workflows", "dev.geml");
  mkdirSync(join(root, ".geml", "workflows"), { recursive: true });
  writeFileSync(file, m.text);
  const loaded = loadStatechart(m.text, file);
  assert.deepEqual(loaded.diagnostics.filter((d) => d.severity === "error"), []);
  for (const s of loaded.statechart.states.values()) {
    if (s.prompt !== undefined) assert.equal(resolvePromptRef(s.prompt, file, root).kind, "found", `${s.id}: ${s.prompt}`);
  }
});

test("a guide named whole, or with an id the flow file has too, stays a document of its own, beside the file in <name>/", () => {
  const flow = '=== diagram {#flow format=geml-statechart}\n{"initial":"a","states":{"a":{"prompt":"./guide.geml"},"b":{"prompt":"./notes.md#x"},"c":{"final":true}}}\n===\n';
  const m = mergedWorkflow("w", flow, (f) => ({ "guide.geml": "# A {#a}\n", "notes.md": "# X {#x}\r\n" })[f]);
  assert.match(m.text, /"prompt":"\.\/w\/guide\.geml"/);
  assert.match(m.text, /"prompt":"\.\/w\/notes\.md#x"/);
  assert.deepEqual([...m.extra.keys()].sort(), ["guide.geml", "notes.md"]);
  assert.equal(m.extra.get("notes.md"), "# X {#x}\n", "text is written with LF");
  const clash = mergedWorkflow("w", flow.replace('"./guide.geml"', '"./guide.geml#flow"'), () => "# Flow {#flow}\n");
  assert.match(clash.text, /"\.\/w\/guide\.geml#flow"/, "an id the flow file has: the guide is not taken in");
});

test("the project's dictionary takes another's rows: a key it has stays, a second default for a use is none, and only the uses asked for come", () => {
  const home = tmp();
  const table = (rows) => `=== table {#tools}\n| tool | for | allow | deny | default | params |\n|---|---|---|---|---|---|\n${rows.map((r) => `| ${r.join(" | ")} |`).join("\n")}\n===\n`;
  assert.equal(mergeTools(home, table([["Read", "", "*", "", "", ""], ["Bash(npm test)", "test", "", "", "yes", ""]])), 2);
  assert.equal(mergeTools(home, table([["Bash(npm test)", "check", "", "", "yes", ""], ["Bash(pnpm test)", "test", "", "", "yes", ""], ["Bash(make)", "build", "", "", "yes", ""]])), 2);
  const rows = readDictionary(read(join(home, ".geml", "tools.geml"))).rows;
  assert.equal(rows.find((r) => r.tool === "Bash(npm test)").for, "test", "the key the project has keeps its use");
  assert.equal(rows.find((r) => r.tool === "Bash(pnpm test)").default, false, "test has its default already");
  assert.equal(rows.find((r) => r.tool === "Bash(make)").default, true);
  assert.equal(mergeTools(home, table([["Bash(cargo test)", "test", "", "", "", ""], ["Bash(lint)", "lint", "", "", "", ""]]), new Set(["lint"])), 1, "only the rows bound to the uses asked for");
});

test("dictionaryPathOf: the project's one for a workflow file of .geml/workflows/, beside the flow file for any other", () => {
  assert.equal(dictionaryPathOf(join("p", ".geml", "workflows", "dev.geml")), join("p", ".geml", "tools.geml"));
  assert.equal(dictionaryPathOf(join("p", ".geml", "workflows", "dev", "flow.geml")), join("p", ".geml", "workflows", "dev", "tools.geml"));
  assert.equal(dictionaryPathOf(join("x", "workflows", "dev", "flow.geml")), join("x", "workflows", "dev", "tools.geml"), "a bundled workflow");
  assert.equal(dictionaryPathOf(".geml/workflows/coding.geml").split("\\").join("/"), ".geml/tools.geml", "a relative path too");
});

test("a worktree's home is the main working tree, read from its .git file with no git run", () => {
  const main = tmp();
  const wt = tmp();
  mkdirSync(join(main, ".git", "worktrees", "wt"), { recursive: true });
  writeFileSync(join(main, ".git", "worktrees", "wt", "commondir"), "../..\n");
  writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt").split("\\").join("/")}\n`);
  assert.equal(realPath(journalBaseOf(wt)), main);
  mkdirSync(join(wt, "sub"));
  assert.equal(realPath(journalBaseOf(join(wt, "sub"))), join(main, "sub"), "a project directory inside the checkout: its copy in the main tree");
});

test("installedWorkflows: the home's files, then the earlier layout's directories (checkout, then home) for a name the home has no file of", () => {
  const home = tmp();
  const root = tmp();
  mkdirSync(join(home, ".geml", "workflows"), { recursive: true });
  writeFileSync(join(home, ".geml", "workflows", "dev.geml"), "x");
  withWorkflow(root, DEV, "dev");
  withWorkflow(root, DEV, "matter");
  withWorkflow(home, DEV, "coding");
  assert.deepEqual(installedWorkflows(root, home).map((w) => [w.name, w.path]), [
    ["coding", join(home, ".geml", "workflows", "coding", "flow.geml")],
    ["dev", join(home, ".geml", "workflows", "dev.geml")],
    ["matter", join(root, ".geml", "workflows", "matter", "flow.geml")],
  ]);
  assert.equal(projectDocOf(root, home), join(root, ".geml", "gemflow.geml"), "the earlier document, the checkout's first");
  writeFileSync(join(home, ".geml", "project.geml"), "=== meta\nflow-workflow = \"dev\"\n===\n");
  assert.equal(projectDocOf(root, home), join(home, ".geml", "project.geml"));
});

test("a journal's workflow: named relative to the home; the earlier layout's name is the home's file once it is there; the name the project gives it", () => {
  const home = tmp();
  const root = tmp();
  mkdirSync(join(home, ".geml", "workflows"), { recursive: true });
  const file = join(home, ".geml", "workflows", "dev.geml");
  writeFileSync(file, "x");
  assert.equal(recordedPath(root, home, file), ".geml/workflows/dev.geml");
  assert.equal(workflowAt(root, home, ".geml/workflows/dev.geml"), file);
  assert.equal(workflowAt(root, home, ".geml/workflows/dev/flow.geml"), file, "moved");
  assert.equal(workflowAt(root, home, ".geml/workflows/other/flow.geml"), undefined);
  withWorkflow(root, DEV, "other");
  assert.equal(workflowAt(root, home, ".geml/workflows/other/flow.geml"), join(root, ".geml", "workflows", "other", "flow.geml"), "not moved: the checkout's");
  assert.equal(workflowNameOf(root, file), "dev");
  assert.equal(workflowNameOf(root, join(root, ".geml", "workflows", "other", "flow.geml")), "other");
});

test("migrateLayout: each workflow directory becomes one file in the home, its dictionary the project's, gemflow.geml project.geml; what git does not track goes to the trash; a second run moves nothing", () => {
  const root = tmp();
  const trash = tmp();
  withWorkflow(root, DEV, "dev");
  writeFileSync(join(root, ".geml", ".gitignore"), "journals/\ncontext.geml\n*.lock\n");
  const moved = migrateLayout(root, trash, root);
  assert.deepEqual(moved.map((m) => [m.from, m.to, m.kept]), [
    [join(root, ".geml", "workflows", "dev"), join(root, ".geml", "workflows", "dev.geml"), false],
    [join(root, ".geml", "gemflow.geml"), join(root, ".geml", "project.geml"), false],
  ]);
  assert.ok(!existsSync(join(root, ".geml", "workflows", "dev")), "the directory is gone from the project");
  assert.ok(existsSync(join(moved[0].trashed, "flow.geml")), "and kept in the trash");
  assert.ok(!existsSync(join(root, ".geml", "gemflow.geml")));
  assert.match(read(join(root, ".geml", "project.geml")), /flow-workflow = "dev"/);
  assert.ok(readDictionary(read(join(root, ".geml", "tools.geml"))).rows.some((r) => r.tool === "Bash(npm test)"), "the dictionary's rows are the project's");
  assert.equal(read(join(root, ".geml", ".gitignore")), GITIGNORE, "the earlier list is replaced");
  const wf = resolveWorkflow(root, {});
  assert.deepEqual(wf, { name: "dev", path: join(root, ".geml", "workflows", "dev.geml") });
  assert.deepEqual(migrateLayout(root, trash, root), []);
});

test("migrateLayout merges the dictionary the person taught last first: where two disagree on a use's preferred tool, theirs stands", () => {
  const root = tmp();
  withWorkflow(root, DEV, "coding");
  withWorkflow(root, DEV, "dev");
  const taught = join(root, ".geml", "workflows", "dev", "tools.geml");
  // The person said "make Write the default" there.
  writeFileSync(taught, read(taught).split("\n").map((l) => l.startsWith("| Edit ") ? l.replace("| yes     |        |", "|         |        |")
    : l.startsWith("| Write ") ? l.replace("|         |        |", "| yes     |        |") : l).join("\n"));
  const old = new Date("2026-01-01T00:00:00Z");
  utimesSync(join(root, ".geml", "workflows", "coding", "tools.geml"), old, old);
  migrateLayout(root, tmp(), root);
  const rows = readDictionary(read(join(root, ".geml", "tools.geml"))).rows;
  assert.deepEqual(rows.filter((r) => r.for === "edit" && r.default).map((r) => r.tool), ["Write"], "the newer dictionary's default for edit");
});

test("migrateLayout leaves what git tracks where it is: copied into the home, removed by the person's commit", () => {
  const root = realPath(gitRepo("main"));
  const trash = tmp();
  withWorkflow(root, DEV, "dev");
  git(root, "add", ".geml");
  git(root, "commit", "-qm", "workflow");
  const moved = migrateLayout(root, trash, root);
  assert.deepEqual(moved.map((m) => m.kept), [true, true]);
  assert.ok(existsSync(join(root, ".geml", "workflows", "dev", "flow.geml")), "left where it is");
  assert.ok(existsSync(join(root, ".geml", "workflows", "dev.geml")));
  assert.equal(resolveWorkflow(root, {}).path, join(root, ".geml", "workflows", "dev.geml"), "the home's file wins");
});

test("a work item whose journal names the earlier layout's file goes on under the file it moved to", () => {
  const root = realPath(gitRepo("feat/x"));
  withWorkflow(root, DEV, "dev");
  const first = openWorkspace({ root, tools: NO_TOOLS, gh: NO_GH });
  assert.ok(first.ok, first.reason);
  assert.equal(first.ws.status().workflow.path, ".geml/workflows/dev/flow.geml");
  migrateLayout(root, tmp(), root);
  const again = openWorkspace({ root, tools: NO_TOOLS, gh: NO_GH });
  assert.ok(again.ok, again.reason);
  assert.equal(resolve(again.ws.workflowPath), join(root, ".geml", "workflows", "dev.geml"));
  assert.equal(again.ws.status().workflow.default, undefined, "the same workflow, not another beside the default");
});

test("add, import and use write into the home: one file per workflow, its tools in the project's dictionary, the default in project.geml", () => {
  const root = tmp();
  const added = addWorkflow(root, "dev", { activate: true });
  assert.deepEqual(added, { ok: true, name: "dev", target: join(root, ".geml", "workflows", "dev.geml"), activated: true });
  assert.ok(!existsSync(join(root, ".geml", "workflows", "dev")), "no directory");
  assert.ok(readDictionary(read(join(root, ".geml", "tools.geml"))).rows.some((r) => r.for === "deploy-prod"));
  assert.equal(read(join(root, ".geml", ".gitignore")), GITIGNORE);
  assert.deepEqual(addWorkflow(root, "dev", { activate: false }).code, 1, "a name the project has");
  const other = tmp();
  cpSync(fileURLToPath(new URL("../workflows/matter/", import.meta.url)), join(other, "matter"), { recursive: true });
  const imported = importWorkflow(root, join(other, "matter"));
  assert.equal(imported.ok, true, imported.reason);
  assert.equal(imported.activated, false, "the project has a default");
  assert.ok(existsSync(join(root, ".geml", "workflows", "matter.geml")));
  writeFileSync(join(root, ".geml", "project.geml"), '=== meta\ntitle = "My project"\nflow-workflow = "dev"\n===\n\n# Outline\n');
  assert.deepEqual(useWorkflow(root, "matter"), { ok: true });
  assert.equal(read(join(root, ".geml", "project.geml")), '=== meta\ntitle = "My project"\nflow-workflow = "matter"\n===\n\n# Outline\n', "only the default changes");
  assert.equal(resolveWorkflow(root, {}).name, "matter");
});
