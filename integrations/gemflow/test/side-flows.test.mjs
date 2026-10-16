// Several flows side by side: the default's work item (a branch) and the work
// items of every installed workflow whose work items are files, each under its
// own flow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeGh, gitRepo, hook, withWorkflow } from "./helpers/repo.mjs";
import { existsSync, readFileSync } from "node:fs";
import { ciSuggestions } from "../dist/hosts/claude-code/board.js";
import { othersWaiting } from "../dist/hosts/claude-code/inbox.js";
import { wordsFor } from "../dist/hosts/claude-code/text.js";

const DEV = fileURLToPath(new URL("../workflows/dev/", import.meta.url));
const MATTER = fileURLToPath(new URL("../workflows/matter/", import.meta.url));

/** A project with the dev flow as the default and the matter flow beside it, and one matter. */
export function sideBySide() {
  const root = gitRepo();
  withWorkflow(root, DEV, "dev");
  cpSync(MATTER, join(root, ".geml", "workflows", "matter"), { recursive: true });
  mkdirSync(join(root, ".geml", "matters"));
  writeFileSync(join(root, ".geml", "matters", "logo.geml"), '=== meta\ntitle = "gemflow 标志"\n===\n');
  return root;
}

test("a file the matter flow takes is its work item, beside the dev flow's branch; the shell names every file unit", () => {
  const root = sideBySide();
  const branch = hook(root, { op: "status" });
  assert.deepEqual([branch.shell.status.item.id, branch.shell.status.workflow.name], ["feat/x", "dev"]);
  assert.deepEqual(branch.shell.units, [".geml/matters/*.geml"], "the hooks learn which files are work items of a flow beside this one");
  const matter = hook(root, { op: "status", lastFile: ".geml/matters/logo.geml" });
  assert.deepEqual([matter.shell.status.item.id, matter.shell.status.workflow.name, matter.shell.status.state.id, matter.shell.status.title], [".geml/matters/logo", "matter", "noted", "gemflow 标志"]);
  assert.deepEqual(hook(root, { op: "status", lastFile: "src/app.ts" }).shell.status.workflow.name, "dev", "a file no flow beside takes is the default's");
  const board = hook(root, { op: "board", lastFile: ".geml/matters/logo.geml" }).board;
  assert.deepEqual(board.items.map((i) => [i.id, i.workflow ?? "(default)"]), [[".geml/matters/logo", "matter"], ["feat/x", "(default)"]], "both work items, each under its flow");
});

test("read from the branch, a matter beside it still has its file, its name, its gist and its options", () => {
  const root = sideBySide();
  const logo = { lastFile: ".geml/matters/logo.geml" };
  writeFileSync(join(root, logo.lastFile), '=== meta\ntitle = "gemflow 标志"\nby = "model"\n===\n\n# 现象 {#symptom}\n\n还在用 GEML 的 G。\n');
  hook(root, { op: "status", ...logo });
  hook(root, { op: "verb", name: "move", args: { to: "deciding" }, callId: "v1", ...logo });
  const board = hook(root, { op: "board" }).board;
  const matter = board.items.find((i) => i.id === ".geml/matters/logo");
  assert.deepEqual([matter.file, matter.title, matter.gist, matter.by, matter.stateTitle], [".geml/matters/logo.geml", "gemflow 标志", "还在用 GEML 的 G。", "model", "待你定"]);
  const [card] = othersWaiting(board, "feat/x", wordsFor("zh"));
  assert.deepEqual([card.title, card.tag, card.actions.map((a) => [a.label, a.action.file])], ["gemflow 标志", "事项流程 · 待你定", [["按方案做", logo.lastFile], ["换个方向", logo.lastFile], ["先放着", logo.lastFile]]], "its options press on its file, its stage in its own flow's words");
});

test("several workflows and no choice made: the one whose work item is no file is the default, the others run beside it", () => {
  const root = sideBySide();
  rmSync(join(root, ".geml", "gemflow.geml"));
  assert.equal(hook(root, { op: "status" }).shell.status.workflow.name, "dev");
  assert.equal(hook(root, { op: "status", lastFile: ".geml/matters/logo.geml" }).shell.status.workflow.name, "matter");
});

test("a work item waits for the ones its file names under depends: not done, nobody moves it on; done, it is offered back", () => {
  const root = sideBySide();
  const logo = { lastFile: ".geml/matters/logo.geml" };
  const styles = { lastFile: ".geml/matters/styles.geml" };
  writeFileSync(join(root, styles.lastFile), '=== meta\ntitle = "样式：画布换上新标志"\ndepends = ".geml/matters/logo"\n===\n');
  hook(root, { op: "status", ...logo });
  const waiting = hook(root, { op: "status", ...styles }).shell.status;
  assert.deepEqual(waiting.depends.map((d) => [d.id, d.title, d.flow, d.done]), [[".geml/matters/logo", "gemflow 标志", "事项流程", false]]);
  const refused = hook(root, { op: "advance", to: "doing", ...styles });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /waits for "gemflow 标志" \(\.geml\/matters\/logo\), which is not done yet: until then it only goes back to #noted/);
  const moved = hook(root, { op: "verb", name: "move", args: { to: "deciding" }, callId: "v1", ...styles });
  assert.match(moved.text, /^refused: .* waits for "gemflow 标志"/, "the model's move waits too");
  let board = hook(root, { op: "board", ...logo }).board;
  const s = board.items.find((i) => i.id === ".geml/matters/styles");
  assert.deepEqual([s.depends, s.asks], [[{ id: ".geml/matters/logo", title: "gemflow 标志", done: false, at: board.items.find((i) => i.id === ".geml/matters/logo").at }], undefined], "waiting is nobody's turn");

  hook(root, { op: "advance", to: "doing", ...logo });
  hook(root, { op: "mark", variable: "accept-now", checked: true, ...logo });
  assert.deepEqual(hook(root, { op: "advance", to: "done", ...logo }).entered, ["done"]);
  board = hook(root, { op: "board", ...logo }).board;
  assert.deepEqual(board.items.find((i) => i.id === ".geml/matters/styles").depends.map((d) => d.done), [true]);
  assert.equal(board.items.find((i) => i.id === ".geml/matters/logo").final, true);
  assert.deepEqual(hook(root, { op: "advance", to: "doing", ...styles }).entered, ["doing"], "its dependency done, it moves on");
});

test("CI that finished failing on the branch's head is a suggestion to note it as a matter; noted, the matter is there and the suggestion gone", () => {
  const root = sideBySide();
  const gh = fakeGh();
  gh.set({ pr: "OPEN", runs: [{ name: "test", conclusion: "failure" }, { name: "lint", conclusion: "success" }, { name: "e2e", conclusion: null }] });
  const res = hook(root, { op: "board" }, gh.env);
  const head = res.board.ci.head;
  assert.deepEqual(res.board.ci.failed, ["test"], "a run still going is no failure");
  const [s] = ciSuggestions(res.board, res.shell.units, [], wordsFor("zh"));
  assert.deepEqual([s.kind, s.title, s.tag, s.detail], ["suggest", "CI 挂了：test", "建议 · 事项", [`在 ${head.slice(0, 8)} 上；记成一件事项，修好再验收。`]]);
  const note = s.actions[0].action;
  assert.deepEqual([note.op, note.path, note.dismiss], ["new-item", `.geml/matters/ci-${head.slice(0, 8)}.geml`, `ci-${head.slice(0, 8)}`]);
  assert.equal(hook(root, { op: "new-item", path: note.path, title: note.title, text: note.text }, gh.env).ok, true);
  assert.ok(readFileSync(join(root, note.path), "utf8").startsWith('=== meta\ntitle = "CI 挂了：test"\nby = "gemflow"\n===\n\n# 现象 {#symptom}\n\ntest 在 '));
  assert.equal(hook(root, { op: "new-item", path: note.path, title: "x", text: "" }, gh.env).ok, false, "not twice");
  assert.equal(hook(root, { op: "new-item", path: "src/elsewhere.geml", title: "x", text: "" }, gh.env).ok, false, "only a file a flow takes");
  assert.equal(existsSync(join(root, "src", "elsewhere.geml")), false);
  assert.deepEqual(ciSuggestions(res.board, res.shell.units, [`ci-${head.slice(0, 8)}`], wordsFor("zh")), [], "put away, not asked again");
});
