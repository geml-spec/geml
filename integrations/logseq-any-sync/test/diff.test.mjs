// patchOps: the API v2 operations between two block lists.
import { strict as assert } from "node:assert";
import { patchOps } from "../adapters/anytype/diff.mjs";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const p = (id, text, indent = 0) => ({ id, type: "paragraph", text, ...(indent ? { indent } : {}) });

test("nothing changed: no ops", () => {
  const blocks = [p("a", "A"), p("b", "B")];
  assert.deepEqual(patchOps(blocks, structuredClone(blocks)), { ops: [], inserted: [], pending: false });
});

test("a changed field is one update_block carrying only that field; a dropped field is null", () => {
  const from = [{ id: "a", type: "checkbox", text: "x", checked: true, color: "red" }];
  const to = [{ id: "a", type: "checkbox", text: "y", checked: true }];
  assert.deepEqual(patchOps(from, to).ops, [{ op: "update_block", id: "a", set: { text: "y", color: null } }]);
});

test("new blocks are inserted as runs anchored to existing ones, with relative indents and no ids", () => {
  const from = [p("a", "A"), p("b", "B")];
  const to = [{ type: "paragraph", text: "first", gid: "g0" }, p("a", "A"), { type: "toggle", text: "T", gid: "g1" }, { type: "paragraph", text: "child", indent: 1 }, p("b", "B")];
  const r = patchOps(from, to);
  assert.deepEqual(r.ops, [
    { op: "insert_blocks", position: "first", blocks: [{ type: "paragraph", text: "first" }] },
    { op: "insert_blocks", after: "a", blocks: [{ type: "toggle", text: "T" }, { indent: 1, type: "paragraph", text: "child" }] },
  ]);
  assert.deepEqual(r.inserted, [{ op: 0, gids: ["g0"] }, { op: 1, gids: ["g1", undefined] }]);
});

test("a first child goes inside its parent", () => {
  const from = [p("a", "A")];
  const to = [p("a", "A"), { type: "paragraph", text: "kid", indent: 1 }];
  assert.deepEqual(patchOps(from, to).ops, [{ op: "insert_blocks", inside: "a", position: "first", blocks: [{ type: "paragraph", text: "kid" }] }]);
});

test("reordered blocks: the longest kept run stays, the rest move after their new predecessor", () => {
  const from = [p("a", "A"), p("b", "B"), p("c", "C")];
  const to = [p("c", "C"), p("a", "A"), p("b", "B")];
  assert.deepEqual(patchOps(from, to).ops, [{ op: "move_block", id: "c", position: "first" }]);
});

test("a deleted block takes its deleted children in one recursive delete", () => {
  const from = [p("a", "A"), p("k", "kid", 1), p("b", "B")];
  const to = [p("b", "B")];
  assert.deepEqual(patchOps(from, to).ops, [{ op: "delete_block", id: "a", recursive: true }]);
});

test("a kept child moves out before its parent is deleted", () => {
  const from = [p("a", "A"), p("k", "kid", 1), p("b", "B")];
  const to = [p("k", "kid"), p("b", "B")];
  const ops = patchOps(from, to).ops;
  assert.deepEqual(ops, [
    { op: "move_block", id: "k", position: "first" },
    { op: "delete_block", id: "a", recursive: true },
  ]);
});

test("a block that must move under a block not yet created waits, and so does its parent's deletion", () => {
  const from = [p("a", "A"), p("k", "kid", 1)];
  const to = [{ type: "toggle", text: "new parent", gid: "n" }, p("k", "kid", 1)];
  const r = patchOps(from, to);
  assert.equal(r.pending, true);
  assert.deepEqual(r.ops, [{ op: "insert_blocks", position: "first", blocks: [{ type: "toggle", text: "new parent" }] }]);
});

test("tables and dataviews are replaced whole", () => {
  const from = [{ id: "t", type: "table", columns: [{ id: "c1" }], rows: [{ id: "r1", cells: ["x"] }] }];
  const to = [{ id: "t", type: "table", columns: [{ id: "c1" }], rows: [{ id: "r1", cells: ["y"] }] }];
  assert.deepEqual(patchOps(from, to).ops, [{ op: "replace_subtree", id: "t", blocks: [{ type: "table", columns: [{ id: "c1" }], rows: [{ id: "r1", cells: ["y"] }] }] }]);
});

console.log(`\n${passed} test(s) passed.`);
