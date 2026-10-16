import { test } from "node:test";
import assert from "node:assert/strict";
import { itemState, withItemState, withoutItemState } from "../dist/core/item-state.js";

const DOC = '=== meta\ntitle = "状态带入口"\n===\n\n# 现象 {#symptom}\n\n看板只能从「待处理」进去。\n';

test("the state goes into the item file's meta, the rest of the file as it was", () => {
  assert.equal(withItemState(DOC, "state", "noted"), '=== meta\ntitle = "状态带入口"\nstate = "noted"\n===\n\n# 现象 {#symptom}\n\n看板只能从「待处理」进去。\n');
  const once = withItemState(DOC, "state", "noted");
  assert.equal(withItemState(once, "state", "doing"), once.replace('state = "noted"', 'state = "doing"'), "a state already there: only its value changes");
  assert.equal(withItemState('=== meta\ntitle = "x"\nstate   =  "noted"\n===\n', "state", "doing"), '=== meta\ntitle = "x"\nstate   =  "doing"\n===\n', "its own spacing kept");
  assert.equal(withItemState("# 现象\n\n文字\n", "state", "noted"), '=== meta\nstate = "noted"\n===\n\n# 现象\n\n文字\n', "no meta: one is put first");
  assert.equal(withItemState(DOC.replace(/\n/g, "\r\n"), "state", "noted"), withItemState(DOC, "state", "noted").replace(/\n/g, "\r\n"), "CRLF stays CRLF");
});

test("the state the meta names is read back; the file without it is what the work item holds", () => {
  const doing = withItemState(DOC, "state", "doing");
  assert.equal(itemState(doing, "state"), "doing");
  assert.equal(itemState(DOC, "state"), undefined);
  assert.equal(itemState("# 现象\n", "state"), undefined);
  assert.equal(withoutItemState(doing, "state"), DOC, "where the item stands is no change of what it holds");
  assert.equal(withoutItemState(DOC, "state"), DOC);
  assert.equal(withoutItemState('# 现象 {#symptom}\n\nstate = "x" is prose here\n', "state"), '# 现象 {#symptom}\n\nstate = "x" is prose here\n', "only the meta's own line");
});
