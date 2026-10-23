import { test } from "node:test";
import assert from "node:assert/strict";
import { askJudgeRequest, judgementLine, judgeOptions, judgeRequest, readAskJudgement, readJudgement } from "../dist/hosts/claude-code/judge.js";
import { wordsFor } from "../dist/hosts/claude-code/text.js";

const t = wordsFor("zh");
const advance = (to, label, file) => ({ key: `asks-${to}`, label, action: { op: "advance", to, ...(file ? { file } : {}), say: `${label}：x` } });
const PENDING = [
  { kind: "approve", key: "a", verb: "决定", title: "pi 和 DSH 也记下写过的文件吗", detail: [], actions: [advance("doing", "按方案做", "m/pi.geml"), advance("parked", "先放着", "m/pi.geml")] },
  { kind: "resume", key: "r", verb: "回到", title: "样式：画布换上新标志", detail: [], actions: [{ key: "resume", label: "继续", action: { op: "switch-file", file: "m/styles.geml", say: "继续：样式" } }] },
  { kind: "suggest", key: "s", verb: "决定", title: "node --test 算作跑测试", detail: [], actions: [{ key: "count", label: "算", action: { op: "learn", lessons: [] } }] },
  { kind: "stuck", key: "k", verb: "被拦", title: "Bash(x)", detail: [], actions: [{ key: "pass", label: "放行一次", action: { op: "pass-once", keys: ["x"] } }] },
];

test("the options a judgement may pick: the ways out of a work item and a work item to come back to; a suggestion or a block is the person's to press", () => {
  assert.deepEqual(judgeOptions(PENDING).map((o) => [o.verb, o.title, o.label, o.action.op]), [
    ["决定", "pi 和 DSH 也记下写过的文件吗", "按方案做", "advance"],
    ["决定", "pi 和 DSH 也记下写过的文件吗", "先放着", "advance"],
    ["回到", "样式：画布换上新标志", "继续", "switch-file"],
  ]);
});

test("the request: the last answer, the options numbered, the prompt; the reply read as the option it picks and how sure", () => {
  const options = judgeOptions(PENDING);
  const ask = judgeRequest(options, "方案写进事项了：两种做法，推荐 A。", "好，按方案做吧");
  assert.match(ask.system, /Reply with one JSON object/);
  assert.equal(ask.prompt.split("\n").slice(0, 5).join("\n"), [
    'The assistant\'s last reply began: "方案写进事项了：两种做法，推荐 A。"',
    "Waiting on the person:",
    '1. 决定 "pi 和 DSH 也记下写过的文件吗" — option: "按方案做"',
    '2. 决定 "pi 和 DSH 也记下写过的文件吗" — option: "先放着"',
    '3. 回到 "样式：画布换上新标志" — option: "继续"',
  ].join("\n"));
  assert.match(ask.prompt, /The person now wrote: "好，按方案做吧"/);
  assert.ok(!judgeRequest(options, "", "x").prompt.includes("last reply"), "no last answer, no line for it");
  assert.equal(judgeRequest(options, "", "长".repeat(900)).prompt.includes(`${"长".repeat(800)}…`), true, "a long prompt is cut");

  const picked = readJudgement('Sure: {"option": 1, "sure": true, "why": "按方案做"}', options);
  assert.deepEqual([picked.option.label, picked.sure, picked.why], ["按方案做", true, "按方案做"]);
  assert.equal(readJudgement('{"option": 3, "sure": false, "why": "像是要回去"}', options).sure, false);
  for (const none of ['{"option": 0, "sure": true}', '{"option": 9}', "no json here", "{broken", '{"option": "1"}']) assert.equal(readJudgement(none, options), undefined, none);
});

test("the band's line: a judgement taken says what was chosen, with an undo when it has one; an unsure one asks, 对 or 不是", () => {
  const [option] = judgeOptions(PENDING);
  const taken = judgementLine({ at: "2026-10-15T11:04:00Z", said: "同意", option, sure: true, why: "按方案做", taken: true, undo: { file: "m/pi.geml", rev: 3 } }, t);
  assert.deepEqual([taken.title, taken.note, taken.actions.map((a) => [a.label, a.action.op])], ["你选了 按方案做：pi 和 DSH 也记下写过的文件吗", "按方案做", [["撤销", "judge-undo"]]]);
  const noUndo = judgementLine({ at: "", said: "", option, sure: true, why: "", taken: true }, t);
  assert.deepEqual(noUndo.actions.map((a) => a.label), ["知道了"]);
  const asked = judgementLine({ at: "", said: "", option, sure: false, why: "像是同意", taken: false }, t);
  assert.deepEqual([asked.title, asked.actions.map((a) => [a.label, a.action.op, a.primary ?? false])], ["按方案做：pi 和 DSH 也记下写过的文件吗？", [["对", "judge-yes", true], ["不是", "judge-no", false]]]);
});

test("unsure, the judgement offers up to four picks, the likeliest first, then none of them", () => {
  const options = judgeOptions(PENDING);
  const found = readJudgement('{"option": 1, "sure": false, "also": [2, 1, 3, 7, 2], "why": "不确定"}', options);
  assert.deepEqual(found.alternatives.map((o) => o.label), ["先放着", "继续"], "each once, never the first again, and only numbers that name an option");
  assert.deepEqual(readJudgement('{"option": 1, "sure": true, "also": [2]}', options).alternatives, [], "a sure pick has no others");
  const line = judgementLine({ at: "", said: "", option: found.option, alternatives: found.alternatives, sure: false, why: "不确定", taken: false }, t);
  assert.deepEqual([line.title, line.actions.map((a) => [a.label, a.action])], ["是哪一个？", [
    ["按方案做", { op: "judge-yes" }], ["先放着", { op: "judge-pick", n: 1 }], ["继续：样式：画布换上新标志", { op: "judge-pick", n: 2 }], ["都不是", { op: "judge-no" }],
  ]], "an option of the same work item goes by its button's words, another's by both");
});

test("a question on the band: the request names the question, its answers and the message; the reply is read as yes, no, or no answer", () => {
  const r = askJudgeRequest("轻流程能跳步吗？", ["能", "不能"], "？你不会断句么？");
  assert.match(r.system, /answers a question/);
  assert.match(r.prompt, /"轻流程能跳步吗？"/);
  assert.match(r.prompt, /"能", "不能"/);
  assert.match(r.prompt, /"？你不会断句么？"/);
  assert.equal(readAskJudgement('{"answers": true}'), true);
  assert.equal(readAskJudgement('它答了：{"answers": false}'), false, "the object found in the reply");
  assert.equal(readAskJudgement("yes"), undefined, "no object");
  assert.equal(readAskJudgement('{"answers": "yes"}'), undefined, "not a boolean");
});
