// geml-style profile 的选择器引擎（设计 §4）与诊断目录（设计 §7）。
// 直接 import dist 模块 —— 这些模块刻意不从 geml.js 再导出，见计划的"文件结构"。
import { STYLE_SEVERITY } from "../dist/style-diagnostics.js";
import { parseSelector, candidates, matches, address, selectorConditions, moreSpecific } from "../dist/style-selector.js";
import { parse } from "../dist/geml.js";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

test("诊断目录：结构性错误是 error，未知名字是 warning（设计 §7）", () => {
  assert.equal(STYLE_SEVERITY["selector-unsupported"], "error");
  assert.equal(STYLE_SEVERITY["ambiguous-rule"], "error");
  assert.equal(STYLE_SEVERITY["unknown-state"], "error");
  assert.equal(STYLE_SEVERITY["unknown-value-source"], "error");
  assert.equal(STYLE_SEVERITY["unknown-interaction"], "error");
  assert.equal(STYLE_SEVERITY["unmatched-rule"], "warning");
  assert.equal(STYLE_SEVERITY["unmatched-producer"], "warning");
  assert.equal(STYLE_SEVERITY["unknown-component"], "warning");
  assert.equal(STYLE_SEVERITY["unknown-handler"], "warning");
});

test("诊断目录：没有 binding-cycle —— 构造上不可能（设计 §5.1）", () => {
  assert.equal(Object.hasOwn(STYLE_SEVERITY, "binding-cycle"), false);
});

test("解析：type / .class / #id / [attr] / [attr=val]（设计 §4.1）", () => {
  const r = parseSelector("code.leaf#esc[anchor][kind=call]");
  assert.equal(r.ok, true);
  assert.equal(r.selector.steps.length, 1);
  const s = r.selector.steps[0];
  assert.equal(s.type, "code");
  assert.deepEqual(s.classes, ["leaf"]);
  assert.equal(s.id, "esc");
  assert.deepEqual(s.attrs, [{ key: "anchor" }, { key: "kind", value: "call" }]);
});

test("解析：后代组合子是空白（设计 §4.2）", () => {
  const r = parseSelector("#api table.kpi");
  assert.equal(r.ok, true);
  assert.equal(r.selector.steps.length, 2);
  assert.equal(r.selector.steps[0].id, "api");
  assert.equal(r.selector.steps[1].type, "table");
  assert.deepEqual(r.selector.steps[1].classes, ["kpi"]);
});

test("解析：带引号的属性值里的空白不切分步骤", () => {
  const r = parseSelector('code[anchor="ts:a.ts#f(x, y)"]');
  assert.equal(r.ok, true);
  assert.equal(r.selector.steps.length, 1);
  assert.deepEqual(r.selector.steps[0].attrs, [{ key: "anchor", value: "ts:a.ts#f(x, y)" }]);
});

test("不支持的 CSS 构造必须点名，不得静默失配（设计 §4.4）", () => {
  for (const bad of [":nth-child(2)", "div > p", "a + b", "a ~ b", "*", 'a[href^="x"]']) {
    const r = parseSelector(bad);
    assert.equal(r.ok, false, `应当拒绝：${bad}`);
    assert.equal(r.code, "selector-unsupported");
    assert.match(r.message, /supported: type, \.class, #id, \[attr\], \[attr=val\], descendant/);
  }
});

test("逗号列表是语法糖：等价于 N 条同体分支（设计 §4.1）", () => {
  const r = parseSelector("table.kpi, table.summary");
  assert.equal(r.ok, true);
  assert.equal(r.branches.length, 2);
  assert.equal(r.branches[0].steps[0].classes[0], "kpi");
  assert.equal(r.branches[1].steps[0].classes[0], "summary");
});

const CORPUS = parse(
  '=== meta\ntitle = "c"\n===\n\n' +
  "# Api {#api}\n\n" +
  "=== table {#t1 .kpi format=csv}\na,b\n1,2\n===\n\n" +
  "# Other {#other}\n\n" +
  "=== table {#t2 .kpi format=csv}\na,b\n3,4\n===\n\n" +
  "==== note {#outer}\nprose\n\n=== code {#inner lang=js}\nx\n===\n====\n"
);

const hit = (sel) => {
  const r = parseSelector(sel);
  assert.equal(r.ok, true, `选择器应当解析成功：${sel}`);
  return candidates(CORPUS).filter((c) => r.branches.some((b) => matches(b, c)))
    .map((c) => c.block.id ?? "(anon)");
};

test("匹配：type + class 命中全文档（设计 §4.1）", () => {
  assert.deepEqual(hit("table.kpi"), ["t1", "t2"]);
});

test("匹配：标题节的包含关系按 §3 从扁平序列上算（设计 §4.2）", () => {
  assert.deepEqual(hit("#api table.kpi"), ["t1"]);
  assert.deepEqual(hit("#other table.kpi"), ["t2"]);
});

test("匹配：flow 块的 body 嵌套也是后代", () => {
  assert.deepEqual(hit("#outer code"), ["inner"]);
  assert.deepEqual(hit("note code"), ["inner"]);
});

test("匹配：后代是子序列，不是父子", () => {
  assert.deepEqual(hit("#api table"), ["t1"]);
  // #inner 隔着一层 note 容器，仍是 #other 节的后代 —— 子序列关系
  assert.deepEqual(hit("#other code"), ["inner"]);
  // 而它不在 #api 节里
  assert.deepEqual(hit("#api code"), []);
});

test("匹配：[attr] 测存在，[attr=val] 测相等", () => {
  assert.deepEqual(hit("table[format]"), ["t1", "t2"]);
  assert.deepEqual(hit("table[format=csv]"), ["t1", "t2"]);
  assert.deepEqual(hit("table[format=json]"), []);
});

test("匹配：逗号分支取并集，按文档序去重", () => {
  assert.deepEqual(hit("#t1, #inner"), ["t1", "inner"]);
});

const conds = (s) => selectorConditions(parseSelector(s).selector);

test("偏序：条件集是真超集才更特定（设计 §4.3）", () => {
  assert.equal(moreSpecific(conds("table.kpi[sortable]"), conds("table.kpi")), true);
  assert.equal(moreSpecific(conds("table.kpi"), conds("table")), true);
  assert.equal(moreSpecific(conds("table"), conds("table.kpi")), false);
});

test("偏序：条件集相同不算更特定（情况 2，设计 §4.3）", () => {
  assert.equal(moreSpecific(conds("table.kpi"), conds("table.kpi")), false);
  // 属性书写顺序不影响条件集 —— 集合语义，不是字符串比较
  assert.equal(moreSpecific(conds("table[a][b]"), conds("table[b][a]")), false);
  assert.equal(moreSpecific(conds("table[b][a]"), conds("table[a][b]")), false);
});

test("偏序：互不包含则不可比（情况 3，设计 §4.3）", () => {
  const a = conds("table.kpi"), b = conds("table[sortable]");
  assert.equal(moreSpecific(a, b), false);
  assert.equal(moreSpecific(b, a), false);
});

test("偏序：并集选择器对两者都是真超集 —— 逃生出口永远存在", () => {
  const u = conds("table.kpi[sortable]");
  assert.equal(moreSpecific(u, conds("table.kpi")), true);
  assert.equal(moreSpecific(u, conds("table[sortable]")), true);
});

test("偏序：祖先步骤按位置计入条件集", () => {
  assert.equal(moreSpecific(conds("#api table.kpi"), conds("table.kpi")), true);
  const x = conds("#api table"), y = conds("#other table");
  assert.equal(moreSpecific(x, y), false);
  assert.equal(moreSpecific(y, x), false);
});

test("解析：畸形选择器各自点名，不静默通过", () => {
  const bad = (src, re) => {
    const r = parseSelector(src);
    assert.equal(r.ok, false, `应当拒绝：${src}`);
    assert.match(r.message, re);
  };
  bad("table[unclosed", /unclosed/);
  bad("#a#b", /two ids/);
  bad("table.", /empty class/);
  bad("table#", /empty id/);
  bad("table[]", /empty attribute test/);
  bad("table[=v]", /empty attribute name/);
  bad("table!", /unexpected/);
  bad("", /is not supported/);
  bad("   ", /is not supported/);
});

test("解析：单引号与括号内的引号都不干扰切分", () => {
  const r = parseSelector("code[anchor='a b'] table['x y']");
  assert.equal(r.ok, true);
  assert.equal(r.selector.steps.length, 2);
  assert.deepEqual(r.selector.steps[0].attrs, [{ key: "anchor", value: "a b" }]);
});

test("解析：属性测试里嵌套 `[` 是畸形，拒绝而非猜测", () => {
  const r = parseSelector("code[a[b]]");
  assert.equal(r.ok, false);
  assert.match(r.message, /unexpected/);
});

test("匹配：没有 id 的块用文档序下标当地址", () => {
  const anon = parse('=== meta\ntitle = "a"\n===\n\n=== note\nhi\n===\n');
  const cs = candidates(anon);
  assert.equal(address(cs[cs.length - 1]).startsWith("["), true);
});

console.log(`\n${passed} passed`);
