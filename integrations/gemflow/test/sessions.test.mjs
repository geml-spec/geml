import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "@geml/geml";
import { answerGist, promptGroups, promptLine, promptTail, sessionExport } from "../dist/hosts/claude-code/sessions.js";
import { wordsFor } from "../dist/hosts/claude-code/text.js";

const t = wordsFor("zh");
const P = [
  { id: "p1", at: "2026-10-12T13:40:00Z", text: "把限流中间件的测试补上，然后开 PR。\n===\n第二行", state: "build", item: "feat/x", tools: 7, refusals: 0, entered: [], signals: [] },
  { id: "p2", at: "2026-10-12T13:55:00Z", text: "并发那个用例用 fake timer，别真等。", state: "build", tools: 4, refusals: 0, entered: ["review"], signals: ["tests-pass"] },
  { id: "p3", at: "2026-10-12T14:08:00Z", text: "开 PR，标题写清楚限流策略。", state: "review", tools: 3, refusals: 0, entered: [], signals: ["pr-open"] },
  { id: "p4", at: "2026-10-12T14:30:00Z", text: "", tools: 0, refusals: 3, entered: [], signals: [] },
];

test("prompts group by the stage they were sent in; a line is the first non-empty line, cut to the width", () => {
  assert.deepEqual(promptGroups(P).map((g) => [g.state, g.from, g.to, g.prompts.map((p) => p.id)]), [
    ["build", "2026-10-12T13:40:00Z", "2026-10-12T14:08:00Z", ["p1", "p2"]],
    ["review", "2026-10-12T14:08:00Z", "2026-10-12T14:30:00Z", ["p3"]],
    [undefined, "2026-10-12T14:30:00Z", undefined, ["p4"]],
  ]);
  assert.equal(promptLine("\n\n  hello world  \nmore"), "hello world");
  assert.equal(promptLine("登录接口加限流登录接口加限流", 10), "登录接口…");
  assert.equal(promptTail(P[1], t), "4 次工具调用 · tests-pass ✓ · 进 #review");
  assert.equal(promptTail(P[3], t), "3 次拒绝");
  assert.equal(promptTail({ ...P[3], refusals: 0 }, t), "");
});

test("what a turn did is its answer's first sentence, as plain words", () => {
  assert.equal(answerGist("模块 1（状态带）已经按真实数据算出来了，就是上面这三行。另外有几件事。"), "模块 1（状态带）已经按真实数据算出来了，就是上面这三行。");
  assert.equal(answerGist("```js\nconst x = 1;\n```\n\n## 改了什么\n\n| a | b |\n\n- **改了**状态带：`band.ts`。还有别的"), "改了状态带：band.ts。", "code, headings and tables skipped; marks and emphasis left out");
  assert.equal(answerGist("See [the PR](https://example.com/pr/1). Then more."), "See the PR.");
  assert.equal(answerGist("> quoted line"), "quoted line");
  assert.equal(answerGist("x".repeat(200)), `${"x".repeat(119)}…`);
  for (const none of ["", "\n\n", "```\nonly code\n```", "# 只有标题"]) assert.equal(answerGist(none), undefined, JSON.stringify(none));
});

test("the export: GEML with one text block per prompt (fenced wider than its content), Markdown by stage, JSON whole", () => {
  const geml = sessionExport(P, "geml", "s-1", t);
  const doc = parse(geml);
  assert.deepEqual(doc.diagnostics, []);
  assert.deepEqual(doc.ids, ["session", "prompt-1", "prompt-2", "prompt-3", "prompt-4"]);
  assert.match(geml, /^==== text \{#prompt-1\}\n把限流中间件的测试补上，然后开 PR。\n===\n第二行\n====$/m);
  const index = doc.children.find((b) => b.kind === "block" && b.id === "session").value;
  assert.deepEqual(index.prompts[0], { id: "prompt-1", at: "2026-10-12T13:40:00Z", state: "build", item: "feat/x", tools: 7, refusals: 0, entered: [], signals: [] });
  const md = sessionExport(P, "md", "s-1", t);
  assert.match(md, /^# 会话 s-1\n/);
  assert.match(md, /^## #build · \d\d:\d\d – \d\d:\d\d$/m);
  assert.match(md, /^## 没有阶段 · \d\d:\d\d$/m);
  assert.match(md, /_4 次工具调用 · tests-pass ✓ · 进 #review_/);
  assert.deepEqual(JSON.parse(sessionExport(P, "json", "s-1", t)), { session: "s-1", prompts: P });
});
