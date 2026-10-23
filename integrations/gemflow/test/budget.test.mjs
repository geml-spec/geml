// The board's element budget: the desktop draws a pane of some 1,500 elements and none past it, so the body is cut and says so.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BODY_NODES, elementsIn, fitToBudget } from "../dist/hosts/claude-code/budget.js";

const el = (children = []) => ({ type: "Box", props: {}, children });

test("elements are counted with everything under them; strings and nothing are not elements", () => {
  assert.equal(elementsIn("words"), 0);
  assert.equal(elementsIn(null), 0);
  assert.equal(elementsIn(el()), 1);
  assert.equal(elementsIn(el([el(["a"]), "b", el([el()])])), 4);
  assert.equal(elementsIn([el(), el()]), 2, "a list is its elements");
  assert.equal(elementsIn({ type: "Text", props: { children: [el()] } }), 2, "children under props are counted too");
});

test("the body keeps the leading rows that fit the budget and says how many it left out", () => {
  const rows = Array.from({ length: 400 }, () => el([el(["line"]), el(["tag"])]));
  const cut = fitToBudget(rows, 1_100);
  assert.equal(cut.kept.length, 366, "three elements a row: 366 fit in 1,100");
  assert.equal(cut.left, 34);
  assert.ok(cut.drawn <= 1_100);
  const all = fitToBudget(rows.slice(0, 10));
  assert.deepEqual([all.kept.length, all.left, all.drawn], [10, 0, 30], "what fits is drawn whole");
  assert.ok(BODY_NODES < 1_476, "under what the desktop was seen to draw");
});
