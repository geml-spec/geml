// The ask tool: what the model registers as a question for the status band.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ASK_TOOL, askedOf } from "../dist/core/ask-tool.js";

test("a registered question: the whole question, two to four answers, the recommended one first", () => {
  assert.deepEqual(askedOf({ question: " 推送 feat/x？ ", options: ["暂不", "推送"], recommended: "推送" }), { question: "推送 feat/x？", options: ["推送", "暂不"], recommended: "推送" });
  assert.deepEqual(askedOf({ question: "Which one?", options: ["A plan", "B plan", "A plan"] }), { question: "Which one?", options: ["A plan", "B plan"] }, "an answer given twice counts once");
  assert.deepEqual(askedOf({ question: "", options: ["a", "b"] }), { error: "question is empty" });
  assert.deepEqual(askedOf({ question: "q?", options: ["only"] }), { error: "options are two to 4 answers" });
  assert.deepEqual(askedOf({ question: "q?", options: ["a", "b", "c", "d", "e"] }), { error: "options are two to 4 answers" });
  assert.deepEqual(askedOf({ question: "q?", options: ["a", "b"], recommended: "c" }), { error: "recommended is one of options" });
  assert.equal(ASK_TOOL.name, "ask");
  assert.deepEqual(ASK_TOOL.inputSchema.required, ["question", "options"]);
});
