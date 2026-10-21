import { test } from "node:test";
import assert from "node:assert/strict";
import { statusShareText } from "../dist/hosts/claude-code/share.js";
import { wordsFor } from "../dist/hosts/claude-code/text.js";

const t = wordsFor("zh");
const next = (over) => ({ judge: "machine", approval: false, reads: [], missing: [], holds: true, note: "", ...over });
const status = {
  workflow: { name: "dev", path: ".geml/workflows/dev/flow.geml", title: "开发流程" }, item: { kind: "item", id: "feat/rate-limit" },
  state: { id: "review", title: "评审", rev: 7, uses: ["edit"], final: false, since: "2026-10-12T13:40:00Z" },
  vars: { "pr-merged": true, "ci-pass": true }, sources: { "pr-merged": "git:pr-merged", "ci-pass": "git:ci-success" },
  next: [next({ name: "review→deploy", to: "deploy", approval: true, reads: ["pr-merged", "ci-pass"] })], refusals: 3, paused: false,
};
const shell = { status, policy: { relevant: ["ci-pass", "pr-merged"] }, contextKey: "feat/rate-limit@7" };

test("where it stands, for a message or a PR comment: the work item, its flow and stage; what waits to be decided and accepted; its latest artifacts", () => {
  const decide = (title) => ({ kind: "approve", key: `a-${title}`, verb: "决定", title, detail: [], actions: [] });
  const accept = (title) => ({ kind: "approve", key: `c-${title}`, verb: "验收", closes: true, title, detail: [], actions: [] });
  const artifacts = { item: "feat/rate-limit", written: [], commits: [
    { sha: "e18b116d00000000", at: "2026-10-12T14:00:00Z", subject: "a", files: [], ours: true },
    { sha: "1111111100000000", at: "2026-10-12T13:59:00Z", subject: "b", files: [], ours: false },
    { sha: "02c959fc00000000", at: "2026-10-12T13:50:00Z", subject: "c", files: [], ours: true },
    { sha: "e1f56bcd00000000", at: "2026-10-12T13:40:00Z", subject: "d", files: [], ours: true },
    { sha: "053f317c00000000", at: "2026-10-12T13:30:00Z", subject: "e", files: [], ours: true },
  ] };
  const pending = [decide("今天的样稿：状态带和各页签"), decide("pi 也记写入吗"), accept("看板显示每件事做出来的东西"), { kind: "stuck", key: "s", verb: "被拦", title: "Bash(wrangler deploy)", detail: [], actions: [] }];
  assert.equal(statusShareText(shell, pending, artifacts, t), [
    "feat/rate-limit · 开发流程 · 评审",
    "需决定：今天的样稿：状态带和各页签（还有 2 件）",
    "需验收：看板显示每件事做出来的东西",
    "最近产物：e18b116d · 02c959fc · e1f56bcd",
  ].join("\n"));
  assert.equal(statusShareText({ ...shell, status: { ...status, title: "状态带入口", paused: true } }, [], undefined, t), "状态带入口 · 开发流程 · 评审 · 已暂停");
  assert.equal(statusShareText(shell, [accept("x"), accept("y")], undefined, wordsFor("en")).split("\n")[1], "To accept: x (1 more)");
  assert.equal(statusShareText({ ...shell, status: { ...status, item: { kind: "inactive", reason: "main" } } }, [], undefined, t), "");
  assert.equal(statusShareText(null, [], undefined, t), "");
});
