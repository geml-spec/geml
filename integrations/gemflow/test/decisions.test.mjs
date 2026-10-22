// What the record takes as a decision (session-log.ts): choices and findings, never status; a deferral is no answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isDeferral, isStatusLine } from "../dist/core/session-log.js";

test("status lines are known by their shape: a version and what it does, pushed or synced or committed, a test count", () => {
  for (const s of [
    "feat/gemflow is pushed to origin at 8b68029e (gemflow 0.2.43).",
    "Synced to ~/.claude/local-marketplaces/geml-dev/gemflow (watched): node suite 709 pass, engine tests 56/56, plugin validate passed.",
    "gemflow 0.2.43 (feat/gemflow): the sessions tab's decisions wrap whole, the before-merging file list is removed.",
    "gemflow 0.2.37 is verified running: after /reload-plugins the next prompt's context carried the instructions.",
    "gemflow 0.2.36 is committed on feat/gemflow as 17a59912; 0.2.37 is synced to the local marketplace but not committed.",
    "0.2.51: the sessions tab draws the newest thirty turns.",
    "Pushed feat/gemflow at 2784db74.",
    "feat/gemflow 已推送到 origin。",
  ]) assert.equal(isStatusLine(s), true, s);
  for (const s of [
    "No copy icon on the status band's text for now: the user chose 先不加 (2026-10-21).",
    "Under the user's Team/Enterprise account the built-in plugin cc-plugin-sec-default@builtin keeps prompt.compose, so gemflow's system-prompt sections never reached the model.",
    "/reload-plugins only reloads the session it is typed in: each session is its own claude.exe holding its own copy of the plugin module.",
    "Correction: gemflow's 产物 are called artifacts, never products.",
    "会话记录统一用 GEML 格式",
    "不可逆的按钮都先弹确认：收尾、删词典行、合并 PR、推送、发 PR 评论、删会话轮次",
    "The IANA reviewer's follow-up asks only that the line-ending text move from Encoding considerations to Interoperability considerations.",
    "要推到 origin 吗？：推",
  ]) assert.equal(isStatusLine(s), false, s);
});

test("a deferral is no answer: 暂不, 先不, later, not now; an answer is", () => {
  for (const l of ["暂不", "先不推", "稍后", "later", "Not now", "skip"]) assert.equal(isDeferral(l), true, l);
  for (const l of ["推", "要", "A 方案", "不要", "Merge"]) assert.equal(isDeferral(l), false, l);
});
