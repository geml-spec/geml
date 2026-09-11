// geml-style 样式表的装载、求解与视图模型（设计 §4/§5/§7）。
import { parse } from "../dist/geml.js";
import { loadStylesheet, resolveStyle } from "../dist/style-resolve.js";
import { STYLE_SEVERITY } from "../dist/style-diagnostics.js";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "geml-style-"));
const p = (n) => join(dir, n);
const w = (n, s) => { writeFileSync(p(n), s); return p(n); };
const cli = (...args) => {
  const r = spawnSync(process.execPath, ["dist/geml.js", ...args], { encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
};

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }
const codes = (ds) => ds.map((d) => d.code).sort();

const sheet = (body) => loadStylesheet(parse('=== meta\nprofile = "geml-style/v1"\n===\n\n' + body));

test("装载：三种块被识别，其余块被忽略（设计 §3.2）", () => {
  const s = sheet(
    '=== style-rule {#r match="table" component=data-table}\n===\n\n' +
    '=== style-state {#sel type=block-ref match="table" on=select value-from=id}\n===\n\n' +
    '=== style-screen {#scr slots="table"}\n===\n\n' +
    "=== note {#ignored}\nnot ours\n===\n"
  );
  assert.deepEqual(s.rules.map((r) => r.id), ["r"]);
  assert.deepEqual(s.states.map((r) => r.id), ["sel"]);
  assert.deepEqual(s.screens.map((r) => r.id), ["scr"]);
});

test("装载：保留键之外的键原样透传为组件参数（设计 §5.4）", () => {
  const s = sheet('=== style-rule {#r match="table" component=kpi-card badge="leaf" collapsed}\n===\n');
  assert.deepEqual(s.rules[0].params, { badge: "leaf", collapsed: true });
  assert.equal(s.rules[0].component, "kpi-card");
  assert.equal(codes(s.diagnostics).length, 0);
});

test("装载：style-rule 缺 match= 是错误", () => {
  const s = sheet("=== style-rule {#r component=data-table}\n===\n");
  assert.deepEqual(codes(s.diagnostics), ["style-missing-attribute"]);
  assert.equal(s.diagnostics[0].severity, "error");
  assert.equal(s.diagnostics[0].rule, "r");
});

test("装载：style-state 缺 match=/on= 是错误", () => {
  const s = sheet("=== style-state {#sel type=block-ref}\n===\n");
  assert.deepEqual(codes(s.diagnostics), ["style-missing-attribute", "style-missing-attribute"]);
});

test("装载：style-state 上的未知键是 warning，不是 error", () => {
  const s = sheet('=== style-state {#sel type=block-ref match="table" on=select bogus=1}\n===\n');
  assert.deepEqual(codes(s.diagnostics), ["style-unknown-attribute"]);
  assert.equal(s.diagnostics[0].severity, "warning");
});

test("装载：不合法的选择器点名报错（设计 §4.4）", () => {
  const s = sheet('=== style-rule {#r match="div > p" component=x}\n===\n');
  assert.deepEqual(codes(s.diagnostics), ["selector-unsupported"]);
  assert.equal(s.diagnostics[0].rule, "r");
});

const CORPUS = parse(
  '=== meta\ntitle = "c"\n===\n\n' +
  "=== table {#kpi .kpi format=csv sortable}\na,b\n1,2\n===\n\n" +
  "=== table {#plain format=csv}\na,b\n3,4\n===\n"
);
const resolve = (body) => resolveStyle(sheet(body), [{ path: "c.geml", doc: CORPUS }]);
// variants[].when 是无原型对象（状态名可以是 __proto__），strict deepEqual 连原型一起比
const W = (o) => Object.assign(Object.create(null), o);
const binding = (vm, addr) => vm.bindings.find((b) => b.block === addr);
const corpus1 = [{ path: "c.geml", doc: CORPUS }];

test("求解：不同属性的规则按属性合并（设计 §4.3）", () => {
  const vm = resolve(
    '=== style-rule {#base match="table" component=data-table}\n===\n\n' +
    '=== style-rule {#kpis match="table.kpi" badge="kpi"}\n===\n'
  );
  assert.deepEqual(codes(vm.diagnostics), []);
  assert.equal(binding(vm, "#kpi").params.component, "data-table");
  assert.equal(binding(vm, "#kpi").params.badge, "kpi");
  assert.equal(binding(vm, "#plain").params.badge, undefined);
});

test("求解：同属性冲突时最特定的赢（情况 1，设计 §4.3）", () => {
  const vm = resolve(
    '=== style-rule {#base match="table" component=data-table}\n===\n\n' +
    '=== style-rule {#kpis match="table.kpi" component=kpi-card}\n===\n'
  );
  assert.deepEqual(codes(vm.diagnostics), []);
  assert.equal(binding(vm, "#kpi").params.component, "kpi-card");
  assert.equal(binding(vm, "#plain").params.component, "data-table");
});

test("求解：条件集相同 + 同属性 = ambiguous-rule 错误（情况 2）", () => {
  const vm = resolve(
    '=== style-rule {#a match="table.kpi" component=x}\n===\n\n' +
    '=== style-rule {#b match="table.kpi" component=y}\n===\n'
  );
  assert.deepEqual(codes(vm.diagnostics), ["ambiguous-rule"]);
  assert.equal(vm.diagnostics[0].severity, "error");
  assert.match(vm.diagnostics[0].message, /#a/);
  assert.match(vm.diagnostics[0].message, /#b/);
  // 情况 2 的补救办法和情况 3 不同：并集在这里是不可能执行的建议
  assert.match(vm.diagnostics[0].message, /selectors are identical/);
  assert.doesNotMatch(vm.diagnostics[0].message, /union/);
});

test("求解：不可比 + 同属性 = ambiguous-rule 错误，并给出并集写法（情况 3）", () => {
  const vm = resolve(
    '=== style-rule {#a match="table.kpi" component=x}\n===\n\n' +
    '=== style-rule {#b match="table[sortable]" component=y}\n===\n'
  );
  assert.deepEqual(codes(vm.diagnostics), ["ambiguous-rule"]);
  assert.match(vm.diagnostics[0].message, /neither is more specific/);
});

test("求解：冲突对着语料判 —— 从不共现的规则不报错（设计 §4.3）", () => {
  const vm = resolve(
    '=== style-rule {#a match="table.kpi" component=x}\n===\n\n' +
    '=== style-rule {#b match="code[anchor]" component=y}\n===\n'
  );
  assert.deepEqual(codes(vm.diagnostics), ["unmatched-rule"]);
  assert.equal(vm.diagnostics[0].severity, "warning");
  assert.equal(vm.diagnostics[0].rule, "b");
});

test("求解：unknown-component 是 warning，惰性回退（设计 §7）", () => {
  const vm = resolveStyle(sheet('=== style-rule {#r match="table" component=nope}\n===\n'), corpus1, { components: ["data-table"] });
  assert.deepEqual(codes(vm.diagnostics), ["unknown-component"]);
  assert.equal(vm.diagnostics[0].severity, "warning");
});

test("状态：规则引用未声明的 $foo 是错误（设计 §7）", () => {
  const vm = resolve('=== style-rule {#r match="table" component=x show="$nope"}\n===\n');
  assert.equal(vm.diagnostics.some((d) => d.code === "unknown-state"), true);
  assert.equal(vm.diagnostics.find((d) => d.code === "unknown-state").severity, "error");
});

test("状态：screen 的槽位也能引用状态，且同样被检查（设计 §5.5）", () => {
  const ok = resolve(
    '=== style-state {#sel type=block-ref match="table" on=select value-from=a}\n===\n\n' +
    '=== style-screen {#s slots="table, $sel"}\n===\n'
  );
  assert.equal(ok.diagnostics.some((d) => d.code === "unknown-state"), false);
  const bad = resolve('=== style-screen {#s slots="table, $ghost"}\n===\n');
  assert.equal(bad.diagnostics.some((d) => d.code === "unknown-state"), true);
  // 槽位在视图模型里已解析：状态记名字，选择器展开成地址列表
  assert.deepEqual(ok.screens[0].slots[1], { kind: "state", state: "sel" });
  assert.equal(ok.screens[0].slots[0].kind, "blocks");
});

test("状态：match= 选不中任何块是 warning（设计 §7）", () => {
  const vm = resolve('=== style-state {#sel type=block-ref match="code[anchor]" on=select value-from=id}\n===\n');
  assert.equal(vm.diagnostics.some((d) => d.code === "unmatched-producer"), true);
  assert.equal(vm.diagnostics.find((d) => d.code === "unmatched-producer").severity, "warning");
});

test("状态：value-from= 不在目标表 schema 里是错误 —— 表有 schema，能真查（设计 §7）", () => {
  const vm = resolve('=== style-state {#sel type=scalar match="table#kpi" on=select value-from=nosuch}\n===\n');
  assert.equal(vm.diagnostics.some((d) => d.code === "unknown-value-source"), true);
  const ok = resolve('=== style-state {#sel type=scalar match="table#kpi" on=select value-from=a}\n===\n');
  assert.equal(ok.diagnostics.some((d) => d.code === "unknown-value-source"), false);
});

test("状态：init-value= 抵达视图模型 —— 消费者看不见的旋钮等于没有旋钮", () => {
  const vm = resolve('=== style-state {#sel type=scalar match="table#kpi" on=select value-from=a init-value=none}\n===\n');
  assert.deepEqual(vm.states, [{ id: "sel", type: "scalar", on: "select", valueFrom: "a", initValue: "none" }]);
  const bare = resolve('=== style-state {#sel type=scalar match="table#kpi" on=select}\n===\n');
  assert.deepEqual(bare.states, [{ id: "sel", type: "scalar", on: "select" }]);
});

test("状态：多产生者是允许的 —— 时序赋值不是静态冲突（设计 §5.2）", () => {
  const vm = resolve('=== style-state {#sel type=block-ref match="table.kpi, table#plain" on=select value-from=a}\n===\n');
  assert.equal(vm.diagnostics.some((d) => d.code === "ambiguous-rule"), false);
  assert.equal(vm.diagnostics.some((d) => d.code === "unmatched-producer"), false);
});

test("CLI：干净的样式表 exit 0", () => {
  w("c.geml", '=== meta\ntitle = "c"\n===\n\n=== table {#kpi .kpi format=csv}\na,b\n1,2\n===\n');
  w("s.geml", '=== meta\nprofile = "geml-style/v1"\n===\n\n=== style-rule {#r match="table.kpi" component=kpi-card}\n===\n');
  const r = cli("style", "check", p("s.geml"), p("c.geml"));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /0 error/);
});

test("CLI：ambiguous-rule 让构建失败（exit 1）", () => {
  w("bad.geml",
    '=== meta\nprofile = "geml-style/v1"\n===\n\n' +
    '=== style-rule {#a match="table.kpi" component=x}\n===\n\n' +
    '=== style-rule {#b match="table[sortable]" component=y}\n===\n');
  w("c2.geml", '=== meta\ntitle = "c"\n===\n\n=== table {#kpi .kpi format=csv sortable}\na,b\n1,2\n===\n');
  const r = cli("style", "check", p("bad.geml"), p("c2.geml"));
  assert.equal(r.code, 1);
  assert.match(r.err + r.out, /ambiguous-rule/);
});

test("CLI：--json 吐出视图模型 —— 本 profile 的一致性面（设计 §8）", () => {
  const r = cli("style", "check", p("s.geml"), p("c.geml"), "--json");
  assert.equal(r.code, 0, r.err);
  const vm = JSON.parse(r.out);
  assert.deepEqual(vm.bindings.map((b) => b.block), ["#kpi"]);
  assert.equal(vm.bindings[0].params.component, "kpi-card");
  assert.deepEqual(vm.diagnostics, []);
});

test("CLI：warning 不影响 exit code", () => {
  w("warn.geml", '=== meta\nprofile = "geml-style/v1"\n===\n\n=== style-rule {#r match="code[anchor]" component=x}\n===\n');
  const r = cli("style", "check", p("warn.geml"), p("c.geml"));
  assert.equal(r.code, 0);
  assert.match(r.out, /unmatched-rule/);
});

test("CLI：没给语料是用法错误（exit 2）", () => {
  const r = cli("style", "check", p("s.geml"));
  assert.equal(r.code, 2);
});

test("装载：style-screen 缺 slots= 是错误，未知键是 warning", () => {
  assert.deepEqual(codes(sheet("=== style-screen {#s layout=grid}\n===\n").diagnostics), ["style-missing-attribute"]);
  const s2 = sheet('=== style-screen {#s slots="table" bogus=1}\n===\n');
  assert.deepEqual(codes(s2.diagnostics), ["style-unknown-attribute"]);
  assert.equal(s2.diagnostics[0].severity, "warning");
});

test("装载：type= 缺省是 block-ref；match= 不合法时点名报错", () => {
  const ok = sheet('=== style-state {#sel match="table" on=select}\n===\n');
  assert.equal(ok.states[0].type, "block-ref");
  const bad = sheet('=== style-state {#sel match="div > p" on=select}\n===\n');
  assert.deepEqual(codes(bad.diagnostics), ["selector-unsupported"]);
});

test("装载：没有 id 的样式块记作 (anon)", () => {
  const s2 = sheet("=== style-rule {component=x}\n===\n");
  assert.equal(s2.diagnostics[0].rule, "(anon)");
});

test("求解：unknown-handler 是 warning，惰性回退（设计 §7）", () => {
  const vm = resolveStyle(sheet('=== style-rule {#r match="table" handler=nope}\n===\n'), corpus1, { handlers: ["subscribe"] });
  assert.deepEqual(codes(vm.diagnostics), ["unknown-handler"]);
  const ok = resolveStyle(sheet('=== style-rule {#r match="table" handler=subscribe}\n===\n'), corpus1, { handlers: ["subscribe"] });
  assert.deepEqual(codes(ok.diagnostics), []);
});

test("状态：目标不是表时跳过 unknown-column，不误报", () => {
  const notes = parse('=== meta\ntitle = "n"\n===\n\n=== note {#n}\nhi\n===\n');
  const vm = resolveStyle(sheet('=== style-state {#sel type=scalar match="note#n" on=select value-from=whatever}\n===\n'), [{ path: "n.geml", doc: notes }]);
  assert.equal(vm.diagnostics.some((d) => d.code === "unknown-value-source"), false);
});

test("求解：非字符串参数不参与 $ 引用扫描", () => {
  const vm = resolve('=== style-rule {#r match="table" component=x dense collapsed=3}\n===\n');
  assert.equal(vm.diagnostics.some((d) => d.code === "unknown-state"), false);
});

test("验收：设计文档 §2 的 codemap 例子，零诊断", () => {
  const r = cli("style", "check", "test/fixtures/style/codemap.style.geml", "test/fixtures/style/codemap-content.geml", "--json");
  assert.equal(r.code, 0, r.err);
  const vm = JSON.parse(r.out);
  assert.deepEqual(vm.diagnostics, []);

  // 叶子方法继承 #methods 的 component，并叠加 #leaves 的修饰（设计 §2.4）
  const leaf = vm.bindings.find((b) => b.block === "#esc");
  assert.equal(leaf.params.component, "method-card");
  assert.equal(leaf.params.collapsed, true);
  assert.equal(leaf.params.badge, "leaf");

  // 非叶子只拿到基础规则
  const nonLeaf = vm.bindings.find((b) => b.block === "#renderHtml");
  assert.equal(nonLeaf.params.component, "method-card");
  assert.equal(nonLeaf.params.collapsed, undefined);

  // 状态与屏幕都在视图模型里
  assert.deepEqual(vm.states.map((s) => s.id), ["sel"]);
  assert.deepEqual(vm.screens[0].slots.map((x) => x.kind), ["blocks", "state"]);
  assert.deepEqual(vm.screens[0].slots[0].blocks, [{ doc: "test/fixtures/style/codemap-content.geml", block: "#calls" }]);
  assert.equal(vm.screens[0].slots[1].state, "sel");
});

test("验收：内容文档一个字节都没为样式而改", () => {
  const before = readFileSync("test/fixtures/style/codemap-content.geml", "utf8");
  cli("style", "check", "test/fixtures/style/codemap.style.geml", "test/fixtures/style/codemap-content.geml");
  assert.equal(readFileSync("test/fixtures/style/codemap-content.geml", "utf8"), before);
});

test("地址按文档限定 —— §4 只保证 id 在单份文档内唯一（多文档语料的常态）", () => {
  const mk = (title, body) => parse(`=== meta\ntitle = "${title}"\n===\n\n${body}`);
  const a = mk("a", "=== note {#budget}\nQ3\n===\n");
  const b = mk("b", "=== note {#budget}\nQ4 —— 另一个块\n===\n");
  const vm = resolveStyle(sheet('=== style-rule {#r match="note" component=callout}\n===\n'),
    [{ path: "a.geml", doc: a }, { path: "b.geml", doc: b }]);
  assert.deepEqual(vm.bindings.map((x) => `${x.doc}${x.block}`), ["a.geml#budget", "b.geml#budget"]);
});

test("匿名块的下标同样按文档限定，不跨文档撞车", () => {
  const mk = (t) => parse(`=== meta\ntitle = "${t}"\n===\n\n=== note\n${t}\n===\n`);
  const vm = resolveStyle(sheet('=== style-rule {#r match="note" component=callout}\n===\n'),
    [{ path: "d1.geml", doc: mk("one") }, { path: "d2.geml", doc: mk("two") }]);
  const addrs = vm.bindings.map((x) => `${x.doc}${x.block}`);
  assert.equal(new Set(addrs).size, 2, `地址必须互不相同，实得 ${JSON.stringify(addrs)}`);
});

test("诊断用 GEML 自己的跨文档引用语法点名出问题的块（§5.2）", () => {
  const doc = parse('=== meta\ntitle = "c"\n===\n\n=== table {#kpi .kpi format=csv sortable}\na,b\n1,2\n===\n');
  const vm = resolveStyle(sheet(
    '=== style-rule {#a match="table.kpi" component=x}\n===\n\n' +
    '=== style-rule {#b match="table[sortable]" component=y}\n===\n'), [{ path: "rep/q3.geml", doc }]);
  assert.match(vm.diagnostics[0].message, /rep\/q3\.geml#kpi/);
});

test("屏幕槽位在构建期解析完 —— 运行时不需要任何选择器逻辑（spike 抓出的缺口）", () => {
  const vm = resolve('=== style-screen {#s slots="table.kpi"}\n===\n');
  const slot = vm.screens[0].slots[0];
  assert.equal(slot.kind, "blocks");
  assert.equal(slot.selector, "table.kpi");
  assert.deepEqual(slot.blocks, [{ doc: "c.geml", block: "#kpi" }]);
});

test("槽位选不中任何块也报 unmatched-rule，和规则一样不静默", () => {
  const vm = resolve('=== style-screen {#s slots="code[anchor]"}\n===\n');
  assert.equal(vm.diagnostics.some((d) => d.code === "unmatched-rule" && d.rule === "s"), true);
});

test("槽位里的畸形选择器点名报错，且该槽位解析成空", () => {
  const vm = resolve('=== style-screen {#s slots="div>p"}\n===\n');
  assert.equal(vm.diagnostics.some((d) => d.code === "selector-unsupported" && d.rule === "s"), true);
  assert.deepEqual(vm.screens[0].slots[0].blocks, []);
});

// ---- screen= ：同一个块在不同屏幕里的不同展示（spike 抓出的表达力缺口）
const twoScreens =
  '=== style-rule {#base match="table#kpi" component=edge-list}\n===\n\n' +
  '=== style-rule {#asGraph match="table#kpi" component=call-graph screen=map}\n===\n\n' +
  '=== style-screen {#list slots="table#kpi"}\n===\n\n' +
  '=== style-screen {#map slots="table#kpi"}\n===\n';

test("screen=：限定屏幕的规则不再和未限定的冲突", () => {
  const vm = resolve(twoScreens);
  assert.equal(vm.diagnostics.some((d) => d.code === "ambiguous-rule"), false);
});

test("screen=：限定屏幕的规则在自己屏幕里胜出，别处不生效", () => {
  const vm = resolve(twoScreens);
  const inScreen = (id) => vm.screens.find((s) => s.id === id)
    .bindings.find((b) => b.block === "#kpi").params.component;
  assert.equal(inScreen("map"), "call-graph");
  assert.equal(inScreen("list"), "edge-list");
});

test("screen=：全局绑定表只含未限定屏幕的规则", () => {
  const vm = resolve(twoScreens);
  assert.equal(vm.bindings.find((b) => b.block === "#kpi").params.component, "edge-list");
});

test("screen=：多值（空格分隔），和 profile/slots 同一个惯例", () => {
  const vm = resolve(
    '=== style-rule {#base match="table#kpi" component=edge-list}\n===\n\n' +
    '=== style-rule {#both match="table#kpi" component=call-graph screen="map atlas"}\n===\n\n' +
    '=== style-screen {#list slots="table#kpi"}\n===\n\n' +
    '=== style-screen {#map slots="table#kpi"}\n===\n\n' +
    '=== style-screen {#atlas slots="table#kpi"}\n===\n');
  const inScreen = (id) => vm.screens.find((s) => s.id === id).bindings.find((b) => b.block === "#kpi").params.component;
  assert.equal(inScreen("map"), "call-graph");
  assert.equal(inScreen("atlas"), "call-graph");
  assert.equal(inScreen("list"), "edge-list");
});

test("screen=：两条规则限定同一屏幕、选择器相同 —— 仍然是 ambiguous-rule", () => {
  const vm = resolve(
    '=== style-rule {#a match="table#kpi" component=x screen=map}\n===\n\n' +
    '=== style-rule {#b match="table#kpi" component=y screen=map}\n===\n\n' +
    '=== style-screen {#map slots="table#kpi"}\n===\n');
  assert.equal(vm.diagnostics.some((d) => d.code === "ambiguous-rule"), true);
  assert.match(vm.diagnostics.find((d) => d.code === "ambiguous-rule").message, /selectors are identical/);
});

test("screen=：点名不存在的屏幕是错误（悬空引用，和 unknown-state 同级）", () => {
  const vm = resolve('=== style-rule {#a match="table#kpi" component=x screen=ghost}\n===\n');
  assert.equal(vm.diagnostics.some((d) => d.code === "unknown-screen"), true);
  assert.equal(vm.diagnostics.find((d) => d.code === "unknown-screen").severity, "error");
});

test("screen=：只在某屏幕生效但那屏幕没选中它的规则，仍报 unmatched-rule 一次", () => {
  const vm = resolve(
    '=== style-rule {#never match="code[anchor]" component=x screen=map}\n===\n\n' +
    '=== style-screen {#map slots="table#kpi"}\n===\n');
  const un = vm.diagnostics.filter((d) => d.code === "unmatched-rule" && d.rule === "never");
  assert.equal(un.length, 1, `应恰好报一次，实得 ${un.length}`);
});

// ---- on= 是封闭词汇，component/handler 是开放注册表
test("on=：非法交互名是**错误**，和 chart-unknown-type 同级（封闭词汇）", () => {
  const vm = resolve('=== style-state {#sel match="table" on=whatever value-from=a}\n===\n');
  const d = vm.diagnostics.find((x) => x.code === "unknown-interaction");
  assert.notEqual(d, undefined, "应报 unknown-interaction");
  assert.equal(d.severity, "error");
  assert.match(d.message, /known: select/);
});

test("on=select 合法，不报", () => {
  const vm = resolve('=== style-state {#sel match="table" on=select value-from=a}\n===\n');
  assert.equal(vm.diagnostics.some((x) => x.code === "unknown-interaction"), false);
});

test("CLI：不声明注册表就不检查 —— 从不触发的诊断比没有更糟", () => {
  w("reg.geml", '=== meta\nprofile = "geml-style/v1"\n===\n\n' +
    '=== style-rule {#r match="table.kpi" component=nope handler=alsonope}\n===\n');
  const silent = cli("style", "check", p("reg.geml"), p("c.geml"));
  assert.equal(silent.code, 0);
  assert.doesNotMatch(silent.out, /unknown-component|unknown-handler/, "没声明就不该报");

  const checked = cli("style", "check", p("reg.geml"), p("c.geml"),
    "--components=edge-list", "--handlers=submit");
  assert.match(checked.out, /unknown-component/);
  assert.match(checked.out, /unknown-handler/);
  assert.equal(checked.code, 0, "两条都是 warning，不该让构建失败");
});

// -- embed：样式表的组合机制（`embed` 就是这个语言的 include）-------------------

const BASE = '=== meta\nprofile = "geml-style/v1"\n===\n\n'
  + '## 默认 {#base}\n\n'
  + '=== style-rule {#d-table match="table" component=card-grid}\n===\n\n'
  + '=== style-rule {#d-code match="code" component=sample}\n===\n';

test("embed 展开：默认层的规则真的生效，例外照 §4 覆盖它", () => {
  // 展开发生在**装载期**，于是展开后所有规则都在同一份表里 —— §4 的仲裁一个字不用改：
  // `table` 与 `table.actions` 本来就是严格超集关系，谁胜出与它来自哪个文件无关。
  w("base.geml", BASE);
  const sh = w("s.geml", '=== meta\nprofile = "geml-style/v1"\n===\n\n'
    + "=== embed {src=base.geml#base}\n===\n\n"
    + '=== style-rule {#a match="table.actions" component=button-row}\n===\n');
  const content = w("c.geml",
    "=== table {#plain}\n| a |\n|---|\n| 1 |\n===\n\n"
    + "=== table {#acts .actions}\n| a |\n|---|\n| 1 |\n===\n\n"
    + "=== code {#c lang=sh}\nls\n===\n");
  const r = cli("style", "check", sh, content, "--json");
  assert.equal(r.code, 0, r.err);
  const vm = JSON.parse(r.out);
  assert.deepEqual(vm.diagnostics, [], "展开成功就不该有诊断");
  const byBlock = Object.fromEntries(vm.bindings.map((b) => [b.block, b.params.component]));
  assert.equal(byBlock["#plain"], "card-grid", "默认层的 table 规则生效了");
  assert.equal(byBlock["#c"], "sample", "默认层的 code 规则生效了");
  assert.equal(byBlock["#acts"], "button-row", "例外覆盖默认 —— 严格超集胜出");
});

test("embed 没有解析器时说出来，而不是静默丢掉它背后的规则", () => {
  // 库调用者不给钩子时，被拉进来的规则一条都不生效。静默是这里最坏的结果：
  // 一份看起来组合好了的样式表，页面却少一大块。
  const s = sheet("=== embed {src=base.geml#base}\n===\n\n"
    + '=== style-rule {#a match="table.actions" component=button-row}\n===\n');
  assert.deepEqual(codes(s.diagnostics), ["style-embed-not-expanded"]);
  assert.match(s.diagnostics[0].message, /base\.geml#base/, "消息要点名是哪一个 embed");
  assert.match(s.diagnostics[0].message, /no document resolver/, "要说清原因");
  assert.equal(s.rules.length, 1, "本文件里的规则照常装载");
});

test("embed 解析不到、锚点不存在、成环 —— 各自说清楚，且都不拒收样式表", () => {
  w("base.geml", BASE);
  const content = w("c2.geml", "=== table {#t}\n| a |\n|---|\n| 1 |\n===\n");
  const cases = [
    ["missing.geml#base", /cannot resolve/],
    ["base.geml#nope", /`#nope` is not in it/],
  ];
  for (const [src, re] of cases) {
    const sh = w(`s-${src.replace(/\W/g, "")}.geml`,
      '=== meta\nprofile = "geml-style/v1"\n===\n\n' + `=== embed {src=${src}}\n===\n`);
    const r = cli("style", "check", sh, content);
    assert.equal(r.code, 0, `${src}: warning 不该让构建失败`);
    assert.match(r.out + r.err, /style-embed-not-expanded/, src);
    assert.match(r.out + r.err, re, src);
  }
  // 自己 embed 自己：环被拦住，不炸栈。
  const loop = w("loop.geml", '=== meta\nprofile = "geml-style/v1"\n===\n\n'
    + "## 顶 {#top}\n\n=== embed {src=loop.geml#top}\n===\n");
  const r = cli("style", "check", loop, content);
  assert.equal(r.code, 0, "环也是 warning");
  assert.match(r.out + r.err, /cycle|deeper than/, r.out + r.err);
});

// -- default-style：清单 meta 里的一次隐式 embed --------------------------------

test("default-style：把清单直接当模板，规则从它指的那份样式表来", () => {
  // 一个根的样式入口只有 `_index/index.geml` 一个固定路径。清单本身不带规则，
  // 它用 `default-style` 说「本站默认是哪一份」—— 装载器把那句话当作一次 embed，
  // 于是 `style check <清单> <文档>` 直接可用，宿主不必先人肉查表再传另一个文件。
  w("dbase.geml", BASE);
  const mf = w("dman.geml", '=== meta\nprofile = "geml-style/v1"\n'
    + 'default-style = "dbase.geml"\n===\n\n本站的样式入口。\n');
  const content = w("dc.geml", "=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\n"
    + "=== code {#c lang=sh}\nls\n===\n");
  const r = cli("style", "check", mf, content, "--json");
  assert.equal(r.code, 0, r.err);
  const vm = JSON.parse(r.out);
  assert.deepEqual(vm.diagnostics, [], "跟到默认样式表就不该有诊断");
  const byBlock = Object.fromEntries(vm.bindings.map((b) => [b.block, b.params.component]));
  assert.equal(byBlock["#t"], "card-grid");
  assert.equal(byBlock["#c"], "sample", "默认样式表的全部规则都到位，不只第一条");
});

test("default-style：模板可以 embed 清单 —— 「给我本站默认，不管它叫什么」", () => {
  // 按名字 `embed {src=dbase.geml#base}` 一直可以；这条测的是那一层间接：
  // 模板只说「本站的默认」，默认样式表改名时模板不用跟着改。
  w("dbase.geml", BASE);
  w("dman.geml", '=== meta\nprofile = "geml-style/v1"\n'
    + 'default-style = "dbase.geml"\n===\n');
  const sh = w("dind.geml", '=== meta\nprofile = "geml-style/v1"\n===\n\n'
    + "=== embed {src=dman.geml}\n===\n\n"
    + '=== style-rule {#a match="table.actions" component=button-row}\n===\n');
  // 语料要覆盖默认层的每一条规则（table 和 code），否则被间接拉进来的那条 code
  // 规则会以 unmatched-rule 现身 —— 那是语料的缺口，不是这层间接的缺陷。
  const content = w("dc2.geml", "=== table {#plain}\n| a |\n|---|\n| 1 |\n===\n\n"
    + "=== table {#acts .actions}\n| a |\n|---|\n| 1 |\n===\n\n"
    + "=== code {#c lang=sh}\nls\n===\n");
  const r = cli("style", "check", sh, content, "--json");
  assert.equal(r.code, 0, r.err);
  const vm = JSON.parse(r.out);
  assert.deepEqual(vm.diagnostics, [], "两跳（清单 → 默认样式表）都该走通");
  const byBlock = Object.fromEntries(vm.bindings.map((b) => [b.block, b.params.component]));
  assert.equal(byBlock["#plain"], "card-grid", "间接拿到了默认层");
  assert.equal(byBlock["#acts"], "button-row", "本地例外照 §4 覆盖它");
});

test("default-style：给了锚点就只要那一节，不再追默认", () => {
  // `embed {src=清单#某节}` 是「我要那一份的那一节」。此时再把 default-style 也拉进来
  // 就违背了作者的明示；锚点不存在照常是那条 not-expanded 诊断，而不是悄悄换成默认。
  w("dbase.geml", BASE);
  // 这份清单既有 default-style，又自己带一节规则 —— 于是「追不追默认」这个分支
  // 在同一个文件上就能观测到差别，不需要两份夹具。
  w("dman2.geml", '=== meta\nprofile = "geml-style/v1"\n'
    + 'default-style = "dbase.geml"\n===\n\n'
    + '## 只有这一节 {#only}\n\n=== style-rule {#o match="note" component=section}\n===\n');
  const content = w("dc3.geml", "=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\n"
    + "=== note {#n}\nhi\n===\n");
  const sh = w("dind2.geml", '=== meta\nprofile = "geml-style/v1"\n===\n\n'
    + "=== embed {src=dman2.geml#only}\n===\n");
  const r = cli("style", "check", sh, content, "--json");
  assert.equal(r.code, 0, r.err);
  const vm = JSON.parse(r.out);
  assert.deepEqual(vm.diagnostics, []);
  assert.deepEqual(vm.bindings.map((b) => b.block).sort(), ["#n"],
    "只有 #only 那一节的规则生效；default-style 指的默认层没被一起拉进来");
});

test("分层：default-style 命中与否都加载 —— #sitemap 那份是叠加，不是替换", () => {
  // 默认层给 code 定了规则，指派的那份只管 table。两条都该生效：CSS 里 @layer 的
  // 下层不会因为上层存在而失效。「替换」式实现会让 #c 一条绑定都没有。
  w("lbase.geml", BASE); // table→card-grid, code→sample
  w("lspecial.geml", '=== meta\nprofile = "geml-style/v1"\n===\n\n'
    + '=== style-rule {#s match="table" component=button-row}\n===\n');
  const mf = w("lman.geml", '=== meta\nprofile = "geml-style/v1"\n'
    + 'default-style = "lbase.geml"\n===\n\n'
    + "=== table {#sitemap}\n| document | template |\n|---|---|\n| lc.geml | lspecial.geml |\n===\n");
  const content = w("lc.geml", "=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\n"
    + "=== code {#c lang=sh}\nls\n===\n");
  const r = cli("style", "check", mf, content, "--json");
  assert.equal(r.code, 0, r.err);
  const vm = JSON.parse(r.out);
  assert.deepEqual(vm.diagnostics, [], "跨层冲突由层号决胜，不该报 ambiguous-rule");
  const byBlock = Object.fromEntries(vm.bindings.map((b) => [b.block, b.params.component]));
  assert.equal(byBlock["#t"], "button-row", "两层都管 table —— 上层（#sitemap 那份）优先");
  assert.equal(byBlock["#c"], "sample", "只有默认层管 code —— 它照样生效，没被替换掉");
});

test("分层：层号先于特异性 —— 下层更具体的规则也压不过上层", () => {
  // 这是层与 specificity 的分野，也是 §4 被扩展的那一处。下层写了 `table.actions`
  // （条件集更大），上层只写了 `table`。CSS 的 @layer 在这里让**上层**赢 —— 层的
  // 意思就是"这一层整体压过下面那层"，而不是"再算一次分数"。
  w("pbase.geml", '=== meta\nprofile = "geml-style/v1"\n===\n\n'
    + '=== style-rule {#deep match="table.actions" component=card-grid}\n===\n');
  w("pover.geml", '=== meta\nprofile = "geml-style/v1"\n===\n\n'
    + '=== style-rule {#flat match="table" component=button-row}\n===\n');
  const mf = w("pman.geml", '=== meta\nprofile = "geml-style/v1"\n'
    + 'default-style = "pbase.geml"\n===\n\n'
    + "=== table {#sitemap}\n| document | template |\n|---|---|\n| pc.geml | pover.geml |\n===\n");
  const content = w("pc.geml", "=== table {#acts .actions}\n| a |\n|---|\n| 1 |\n===\n");
  const r = cli("style", "check", mf, content, "--json");
  assert.equal(r.code, 0, r.err);
  const vm = JSON.parse(r.out);
  assert.deepEqual(vm.diagnostics, []);
  assert.equal(vm.bindings[0].params.component, "button-row",
    "上层的粗规则赢过下层的细规则 —— 层号不是 specificity");
});

test("分层：ambiguous-rule 仍然在**层内**成立 —— §4 没被架空", () => {
  // 层只解决跨层。同一层里条件不可比的两条规则照旧是错误，补救办法也照旧是
  // 「写并集」。这一条钉住扩展的边界：别让层号悄悄把 §4 整个吃掉。
  const content = w("ac.geml", "=== note {#hero}\nhi\n===\n");
  const sh = w("ash.geml", '=== meta\nprofile = "geml-style/v1"\n===\n\n'
    + '=== style-rule {#byType match="note" component=section}\n===\n\n'
    + '=== style-rule {#byId match="#hero" component=hero}\n===\n');
  const r = cli("style", "check", sh, content);
  assert.equal(r.code, 1, "层内不可比 —— 这是 error，构建该失败");
  assert.match(r.err, /ambiguous-rule/);
  assert.match(r.err, /union of both selectors/, "层内的补救办法仍是写并集");
});

test("分层：同一份被指派成 default-style 自己时，不当两层读", () => {
  // 否则它会跟自己比层号，上层那份"赢"了下层的同一份 —— 结果对，但白读一遍，
  // 而且 `#sitemap` 表看起来像是在改变什么。
  w("sbase.geml", BASE);
  const mf = w("sman.geml", '=== meta\nprofile = "geml-style/v1"\n'
    + 'default-style = "sbase.geml"\n===\n\n'
    + "=== table {#sitemap}\n| document | template |\n|---|---|\n| sc.geml | sbase.geml |\n===\n");
  const content = w("sc.geml", "=== table {#t}\n| a |\n|---|\n| 1 |\n===\n\n"
    + "=== code {#c lang=sh}\nls\n===\n");
  const r = cli("style", "check", mf, content, "--json");
  assert.equal(r.code, 0, r.err);
  const vm = JSON.parse(r.out);
  assert.deepEqual(vm.diagnostics, []);
  assert.deepEqual(vm.bindings.map((b) => b.rules.length), [1, 1],
    "每个块只被一条规则命中 —— 同一份没有被读成两层");
});

test("default-style 指向自己 → 照常报 cycle，不炸栈", () => {
  // 隐式 embed 走的是 embed 的同一条路径，所以环检测、深度上限、诊断全部复用。
  const content = w("dc4.geml", "=== table {#t}\n| a |\n|---|\n| 1 |\n===\n");
  const self = w("dself.geml", '=== meta\nprofile = "geml-style/v1"\n'
    + 'default-style = "dself.geml"\n===\n');
  const r = cli("style", "check", self, content);
  assert.equal(r.code, 0, "环是 warning，不拒收样式表");
  assert.match(r.out + r.err, /style-embed-not-expanded/);
  assert.match(r.out + r.err, /cycle|deeper than/, r.out + r.err);
});

// ---------------------------------------------------------------- 计划 E（设计 §12）

test("诊断目录：frame 相关的四个码与 style-invalid-value（设计 §12.4 / §7）", () => {
  assert.equal(STYLE_SEVERITY["unknown-frame"], "error");
  assert.equal(STYLE_SEVERITY["screen-nested"], "error");
  assert.equal(STYLE_SEVERITY["frame-cycle"], "error");
  assert.equal(STYLE_SEVERITY["unused-frame"], "warning");
  assert.equal(STYLE_SEVERITY["style-invalid-value"], "error");
});

test("profile：style-frame 是本 profile 的类型，geml check 不再报 unknown-block-type", () => {
  const f = w("frame-known.geml",
    '=== meta\nprofile = "geml-style/v1"\n===\n\n' +
    '=== style-frame {#body slots="table"}\n===\n');
  const r = cli("check", f);
  assert.equal(r.out.includes("unknown-block-type"), false, r.out + r.err);
});

test("装载：style-frame 被读成容器，与 style-screen 同形（设计 §12.4）", () => {
  const s = sheet(
    '=== style-screen {#page axis=column slots="text#hdr, #body"}\n===\n\n' +
    '=== style-frame  {#body axis=row slots="table#tree, text#main"}\n===\n'
  );
  assert.deepEqual(s.screens.map((x) => [x.id, x.axis]), [["page", "column"]]);
  assert.deepEqual(s.frames.map((x) => [x.id, x.axis, x.slots]), [["body", "row", ["table#tree", "text#main"]]]);
  assert.deepEqual(codes(s.diagnostics), []);
});

test("装载：axis 默认 column；域外值是 style-invalid-value 错误", () => {
  const ok = sheet('=== style-frame {#f slots="table"}\n===\n');
  assert.equal(ok.frames[0].axis, "column");
  const bad = sheet('=== style-frame {#f axis=diagonal slots="table"}\n===\n');
  assert.deepEqual(codes(bad.diagnostics), ["style-invalid-value"]);
  assert.equal(bad.diagnostics[0].rule, "f");
  assert.equal(bad.frames[0].axis, "column");
});

test("装载：screen/frame 上的 component= 是宿主命名的排布；layout= 已改名，报 warning 并指路", () => {
  const s = sheet(
    '=== style-screen {#a component=grid slots="table"}\n===\n\n' +
    '=== style-screen {#b layout=split slots="table"}\n===\n'
  );
  assert.equal(s.screens[0].component, "grid");
  assert.deepEqual(codes(s.diagnostics), ["style-unknown-attribute"]);
  assert.match(s.diagnostics[0].message, /layout=.*component=/);
  assert.equal(s.screens[1].component, undefined);
});

test("装载：style-frame 缺 slots= 是错误，消息点名 style-frame", () => {
  const s = sheet("=== style-frame {#f}\n===\n");
  assert.deepEqual(codes(s.diagnostics), ["style-missing-attribute"]);
  assert.match(s.diagnostics[0].message, /style-frame/);
});

test("装载：内含词落 box，组件词落 params，二者结构上分开（设计 §12.3）", () => {
  const s = sheet('=== style-rule {#r match="table" component=tree width=321px sticky=0 scroll=own hide-below=1012 collapsible indent=2}\n===\n');
  assert.deepEqual(s.rules[0].box, { width: "321px", sticky: 0, scroll: "own", "hide-below": 1012 });
  assert.deepEqual(s.rules[0].params, { collapsible: true, indent: 2 });
  assert.deepEqual(codes(s.diagnostics), []);
});

test("装载：封闭值域的内含词取了域外值是 style-invalid-value；开放值域的不校验", () => {
  const bad = sheet('=== style-rule {#r match="table" scroll=sideways sticky=top hide-below=wide}\n===\n');
  assert.deepEqual(codes(bad.diagnostics), ["style-invalid-value", "style-invalid-value", "style-invalid-value"]);
  const ok = sheet('=== style-rule {#r match="table" width=anything color="not a colour" border="3 dashed"}\n===\n');
  assert.deepEqual(codes(ok.diagnostics), []);
  assert.deepEqual(ok.rules[0].box, { width: "anything", color: "not a colour", border: "3 dashed" });
});

test("求解：binding 上 box 与 params 并列，仲裁对两者一视同仁（设计 §12.3）", () => {
  const vm = resolve(
    '=== style-rule {#base match="table" width=100px component=data-table}\n===\n\n' +
    '=== style-rule {#kpis match="table.kpi" width=200px}\n===\n'
  );
  assert.deepEqual(codes(vm.diagnostics), []);
  assert.equal(binding(vm, "#kpi").box.width, "200px");
  assert.equal(binding(vm, "#plain").box.width, "100px");
  assert.equal(binding(vm, "#kpi").params.component, "data-table");
  assert.equal(binding(vm, "#kpi").box.component, undefined);
});

test("装载：on=toggle 进闭集；其它仍是 unknown-interaction", () => {
  const ok = sheet('=== style-state {#tree type=scalar match="table" on=toggle init-value=open}\n===\n');
  assert.deepEqual(codes(ok.diagnostics), []);
  assert.equal(ok.states[0].on, "toggle");
  const bad = sheet('=== style-state {#t type=scalar match="table" on=hover}\n===\n');
  assert.deepEqual(codes(bad.diagnostics), ["unknown-interaction"]);
});

test("装载：when= 解析成 $state=value 的列表，逗号并列（设计 §12.5）", () => {
  const s = sheet('=== style-rule {#r match="table" when="$tree=closed, $tab=Code" width=0}\n===\n');
  assert.deepEqual(s.rules[0].when, [{ state: "tree", value: "closed" }, { state: "tab", value: "Code" }]);
  assert.equal(s.rules[0].params.when, undefined, "when 是保留键，不透传");
  const plain = sheet('=== style-rule {#p match="table" width=0}\n===\n');
  assert.deepEqual(plain.rules[0].when, []);
});

test("装载：when= 形式不对是 style-invalid-value，且只做相等", () => {
  for (const bad of ['when="tree=closed"', 'when="$tree"', 'when="$tree!=closed"', 'when="$tree=closed or $tab=Code"']) {
    const s = sheet(`=== style-rule {#r match="table" ${bad} width=0}\n===\n`);
    assert.deepEqual(codes(s.diagnostics), ["style-invalid-value"], bad);
  }
});

test("frame：槽位里裸 #x 是本样式表的 frame，带类型的才是语料块（设计 §12.4）", () => {
  const vm = resolve(
    '=== style-screen {#page slots="table#kpi, #body"}\n===\n\n' +
    '=== style-frame  {#body axis=row slots="table#plain"}\n===\n'
  );
  assert.deepEqual(codes(vm.diagnostics), []);
  assert.deepEqual(vm.screens[0].slots[1], { kind: "frame", frame: "body" });
  assert.equal(vm.screens[0].slots[0].kind, "blocks");
  assert.deepEqual(vm.frames.map((f) => [f.id, f.axis, f.slots[0].kind]), [["body", "row", "blocks"]]);
});

test("frame：裸 #x 没有对应 style-frame 是 unknown-frame 错误，消息教人加类型", () => {
  const vm = resolve('=== style-screen {#page slots="#kpi"}\n===\n');
  assert.deepEqual(codes(vm.diagnostics), ["unknown-frame"]);
  assert.match(vm.diagnostics[0].message, /text#kpi|a corpus block needs a type/);
  assert.equal(vm.diagnostics[0].rule, "page");
});

test("frame：裸 #x 指到 style-screen 是 screen-nested 错误 —— 页不能装进页", () => {
  const vm = resolve(
    '=== style-screen {#a slots="#b"}\n===\n\n' +
    '=== style-screen {#b slots="table"}\n===\n'
  );
  assert.deepEqual(codes(vm.diagnostics), ["screen-nested"]);
});

test("frame：区域装区域成环是 frame-cycle 错误，消息带整条链", () => {
  const vm = resolve(
    '=== style-screen {#page slots="#a"}\n===\n\n' +
    '=== style-frame {#a slots="#b"}\n===\n\n' +
    '=== style-frame {#b slots="#c"}\n===\n\n' +
    '=== style-frame {#c slots="#a"}\n===\n'
  );
  const cyc = vm.diagnostics.filter((d) => d.code === "frame-cycle");
  assert.equal(cyc.length, 1, JSON.stringify(vm.diagnostics));
  assert.match(cyc[0].message, /#a → #b → #c → #a/);
  const self = resolve('=== style-frame {#a slots="#a"}\n===\n');
  assert.match(self.diagnostics.find((d) => d.code === "frame-cycle").message, /#a → #a/);
});

test("frame：声明了没人引用是 unused-frame warning", () => {
  const vm = resolve(
    '=== style-screen {#page slots="table"}\n===\n\n' +
    '=== style-frame {#orphan slots="table"}\n===\n'
  );
  assert.deepEqual(codes(vm.diagnostics), ["unused-frame"]);
  assert.equal(vm.diagnostics[0].severity, "warning");
  assert.equal(vm.diagnostics[0].rule, "orphan");
});

test("frame：#x 不再拿去匹配语料，所以不会再有那条 unmatched-rule", () => {
  const vm = resolve(
    '=== style-screen {#page slots="#body"}\n===\n\n' +
    '=== style-frame {#body slots="table"}\n===\n'
  );
  assert.equal(vm.diagnostics.some((d) => d.code === "unmatched-rule"), false);
});

const TREE = parse(
  '=== meta\ntitle = "t"\n===\n\n' +
  "=== table {#tree .region format=csv}\nname\nagents\n===\n\n" +
  "=== text {#toolbar}\nPreview Code Blame\n===\n"
);
const resolveT = (body) => resolveStyle(sheet(body), [{ path: "t.geml", doc: TREE }]);
const bT = (vm, addr) => vm.bindings.find((b) => b.block === addr);

test("when：有条件的规则不进基础参数，进 variants；条件集是无条件那条的真超集，不报错（设计 §12.5）", () => {
  const vm = resolveT(
    '=== style-state {#tree type=scalar match="table#tree" on=toggle init-value=open}\n===\n\n' +
    '=== style-rule {#open   match="table#tree" component=tree width=321px sticky=0}\n===\n\n' +
    '=== style-rule {#closed match="table#tree" when="$tree=closed" width=0}\n===\n'
  );
  assert.deepEqual(codes(vm.diagnostics), []);
  const b = bT(vm, "#tree");
  assert.deepEqual(b.box, { width: "321px", sticky: 0 });
  assert.equal(b.params.component, "tree");
  assert.deepEqual(b.variants, [{ when: W({ tree: "closed" }), box: { width: 0 }, params: {} }]);
});

test("when：互斥的 when 集合（同状态不同值）争同一属性不是冲突 —— tab 条的写法", () => {
  const vm = resolveT(
    '=== style-state {#tab type=scalar match="text#toolbar" on=select init-value=Preview}\n===\n\n' +
    '=== style-rule {#a match="text#toolbar" when="$tab=Preview" border="2px #fd8c73"}\n===\n\n' +
    '=== style-rule {#b match="text#toolbar" when="$tab=Code"    border="2px #fd8c73"}\n===\n'
  );
  assert.deepEqual(codes(vm.diagnostics), []);
  assert.equal(bT(vm, "#toolbar").variants.length, 2);
});

test("when：可同时成立、互不包含、争同一属性 → ambiguous-rule（设计 §12.5）", () => {
  const vm = resolveT(
    '=== style-state {#tree type=scalar match="table#tree" on=toggle}\n===\n\n' +
    '=== style-state {#tab  type=scalar match="text#toolbar" on=select}\n===\n\n' +
    '=== style-rule {#a match="table#tree" when="$tree=closed" width=0}\n===\n\n' +
    '=== style-rule {#b match="table#tree" when="$tab=Code"    width=100px}\n===\n'
  );
  assert.deepEqual(codes(vm.diagnostics), ["ambiguous-rule"]);
});

test("when：有条件但选择器更弱的规则，对无条件的强选择器规则 → 不可比 → ambiguous-rule", () => {
  const vm = resolveT(
    '=== style-state {#tree type=scalar match="table" on=toggle}\n===\n\n' +
    '=== style-rule {#strong match="table#tree" width=321px}\n===\n\n' +
    '=== style-rule {#weak   match="table" when="$tree=closed" width=0}\n===\n'
  );
  assert.deepEqual(codes(vm.diagnostics), ["ambiguous-rule"]);
});

test("when：variants 按条件数升序 —— 真超集排在后面，运行时无需再比", () => {
  const vm = resolveT(
    '=== style-state {#tree type=scalar match="table" on=toggle}\n===\n\n' +
    '=== style-state {#tab  type=scalar match="text#toolbar" on=select}\n===\n\n' +
    '=== style-rule {#two match="table#tree" when="$tree=closed, $tab=Code" padding=0}\n===\n\n' +
    '=== style-rule {#one match="table#tree" when="$tree=closed" padding=8px}\n===\n'
  );
  assert.deepEqual(codes(vm.diagnostics), []);
  assert.deepEqual(bT(vm, "#tree").variants.map((v) => Object.keys(v.when).length), [1, 2]);
});

test("when：引用未声明的状态是 unknown-state", () => {
  const vm = resolveT('=== style-rule {#r match="table#tree" when="$ghost=1" width=0}\n===\n');
  assert.deepEqual(codes(vm.diagnostics), ["unknown-state"]);
});

test("when：无条件规则的 variants 是空数组，既有绑定形状不变", () => {
  const vm = resolve('=== style-rule {#base match="table" component=data-table}\n===\n');
  assert.deepEqual(binding(vm, "#kpi").variants, []);
});


test("验收：GitHub blob 页的样式表 —— 0 error 0 warning，视图模型是 §12.6 的形状", () => {
  const dir = join("test", "fixtures", "style-page");
  // 先过核心 check：fixture 里的每个块类型都得是注册过的 —— 曾经用了不存在的 prose，只有这一步能抓到
  for (const f of ["first-page.geml", "first-page.style.geml"]) {
    const c = cli("check", join(dir, f));
    assert.equal(c.code, 0, f + ": " + c.out + c.err);
    assert.equal(/unknown block type/.test(c.out + c.err), false, f + ": " + c.out);
  }
  const r = cli("style", "check", join(dir, "first-page.style.geml"), join(dir, "first-page.geml"));
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /0 error\(s\), 0 warning\(s\)/);

  const j = cli("style", "check", join(dir, "first-page.style.geml"), join(dir, "first-page.geml"), "--json");
  const vm = JSON.parse(j.out);
  assert.deepEqual(vm.screens.map((s) => [s.id, s.axis]), [["page", "column"]]);
  assert.deepEqual(vm.screens[0].slots.map((s) => s.kind), ["blocks", "blocks", "frame"]);
  assert.deepEqual(vm.frames.map((f) => [f.id, f.axis]), [["body", "row"], ["main", "column"], ["card", "column"]]);
  // #body 的槽位现在是三个：状态控件（折叠开关，必须在被折叠的树**外面**）、树、右侧
  assert.deepEqual(vm.frames[0].slots.map((s) => s.kind), ["state", "blocks", "frame"]);
  assert.deepEqual(vm.frames[0].slots[0], { kind: "state", state: "tree" });
  assert.deepEqual(vm.frames[0].slots[2], { kind: "frame", frame: "main" });

  const tree = vm.bindings.find((b) => b.block === "#file-tree");
  assert.deepEqual(tree.box, { width: "321px", sticky: 0, scroll: "own", "hide-below": 1012 });
  assert.equal(tree.params.component, "tree");
  assert.deepEqual(tree.variants, [{ when: { tree: "closed" }, box: { width: 0 }, params: {} }]);

  const body = vm.bindings.find((b) => b.block === "#content");
  assert.equal(body.box["max-width"], "1012px");
  assert.equal(body.box.padding, "32px");
  assert.deepEqual(vm.states.map((s) => [s.id, s.on]), [["tree", "toggle"], ["tab", "select"]]);
});


test("when：variant 与基础参数来自不同层 —— 层号高的保留，低的丢掉该属性（设计 §12.5 跨层）", () => {
  // 低层（default-style）有条件、高层（入口自己）无条件：高层赢，低层那个只剩空壳的组不再是 variant。
  w("lbase.geml", '=== meta\nprofile = "geml-style/v1"\n===\n\n'
    + '=== style-state {#tree type=scalar match="table" on=toggle}\n===\n\n'
    + '=== style-rule {#low match="table#t" when="$tree=closed" width=0}\n===\n');
  const mf = w("lman.geml", '=== meta\nprofile = "geml-style/v1"\ndefault-style = "lbase.geml"\n===\n\n'
    + '=== style-rule {#top match="table#t" width=321px}\n===\n');
  const content = w("lc.geml", "=== table {#t}\n| a |\n|---|\n| 1 |\n===\n");
  const r = cli("style", "check", mf, content, "--json");
  assert.equal(r.code, 0, r.err);
  const vm = JSON.parse(r.out);
  assert.deepEqual(vm.diagnostics, []);
  const b = vm.bindings.find((x) => x.block === "#t");
  assert.equal(b.box.width, "321px");
  assert.deepEqual(b.variants, []);

  // 反向：有条件的在高层、无条件的在低层 → 基础参数丢掉 width，variant 保留它。
  w("lbase2.geml", '=== meta\nprofile = "geml-style/v1"\n===\n\n'
    + '=== style-rule {#low match="table#t" width=321px}\n===\n');
  const mf2 = w("lman2.geml", '=== meta\nprofile = "geml-style/v1"\ndefault-style = "lbase2.geml"\n===\n\n'
    + '=== style-state {#tree type=scalar match="table" on=toggle}\n===\n\n'
    + '=== style-rule {#top match="table#t" when="$tree=closed" width=0}\n===\n');
  const r2 = cli("style", "check", mf2, content, "--json");
  assert.equal(r2.code, 0, r2.err);
  const b2 = JSON.parse(r2.out).bindings.find((x) => x.block === "#t");
  assert.equal(b2.box.width, undefined);
  assert.deepEqual(b2.variants, [{ when: { tree: "closed" }, box: { width: 0 }, params: {} }]);
});


// ---------------------------------------------------------------- 把剩下的分支走一遍

test("装载：没有 meta 的样式表也能装（入口层为空）", () => {
  const s = loadStylesheet(parse('=== style-rule {#r match="table" component=x}\n===\n'));
  assert.deepEqual(s.rules.map((r) => r.id), ["r"]);
  assert.deepEqual(codes(s.diagnostics), []);
});

test("装载：filter= 是保留键，落在 rule.filter 并进入绑定参数", () => {
  const vm = resolve(
    '=== style-state {#conf type=scalar match="table" on=select value-from=a}\n===\n\n' +
    '=== style-rule {#r match="table" filter="a=$conf"}\n===\n'
  );
  assert.deepEqual(codes(vm.diagnostics), []);
  assert.equal(binding(vm, "#kpi").params.filter, "a=$conf");
});

test("求解：一条规则多个分支同时命中一个块时取最特定的那一支，两种顺序都对", () => {
  const a = resolve('=== style-rule {#r match="table, table.kpi" component=x}\n===\n');
  const b = resolve('=== style-rule {#r match="table.kpi, table" component=x}\n===\n');
  for (const vm of [a, b]) {
    assert.deepEqual(codes(vm.diagnostics), []);
    assert.equal(binding(vm, "#kpi").params.component, "x");
    assert.equal(binding(vm, "#plain").params.component, "x");
  }
});

test("求解：更特定的规则写在前面，后面的粗规则不覆盖它（情况 1 的另一个方向）", () => {
  const vm = resolve(
    '=== style-rule {#kpis match="table.kpi" component=kpi-card}\n===\n\n' +
    '=== style-rule {#base match="table" component=data-table}\n===\n'
  );
  assert.deepEqual(codes(vm.diagnostics), []);
  assert.equal(binding(vm, "#kpi").params.component, "kpi-card");
  assert.equal(binding(vm, "#plain").params.component, "data-table");
});

test("求解：未限定屏幕的冲突在有屏幕时仍只报一次，不随屏幕数翻倍", () => {
  const vm = resolve(
    '=== style-rule {#a match="table" component=x}\n===\n\n' +
    '=== style-rule {#b match="table" component=y}\n===\n\n' +
    '=== style-screen {#s1 slots="table"}\n===\n\n' +
    '=== style-screen {#s2 slots="table"}\n===\n'
  );
  const amb = vm.diagnostics.filter((d) => d.code === "ambiguous-rule");
  assert.equal(amb.length, 2, JSON.stringify(amb)); // 语料里两个块各一条，不是 2 × (1 + 两个屏幕)
  for (const d of amb) assert.equal(/in screen/.test(d.message), false, d.message);
});

test("求解：screen / frame 上的 component= 进视图模型", () => {
  const vm = resolve(
    '=== style-screen {#a component=grid slots="#f"}\n===\n\n' +
    '=== style-frame  {#f component=list slots="table"}\n===\n'
  );
  assert.deepEqual(codes(vm.diagnostics), []);
  assert.equal(vm.screens[0].component, "grid");
  assert.equal(vm.frames[0].component, "list");
});

test("when：基础参数被高层接管后，低层那个只争这一个属性的 variant 整个消失", () => {
  w("l3base.geml", '=== meta\nprofile = "geml-style/v1"\n===\n\n'
    + '=== style-state {#tree type=scalar match="table" on=toggle}\n===\n\n'
    + '=== style-rule {#base0 match="table#t" width=100px}\n===\n\n'
    + '=== style-rule {#cond0 match="table#t" when="$tree=closed" width=0}\n===\n');
  const mf = w("l3man.geml", '=== meta\nprofile = "geml-style/v1"\ndefault-style = "l3base.geml"\n===\n\n'
    + '=== style-rule {#top match="table#t" width=321px}\n===\n');
  const content = w("l3c.geml", "=== table {#t}\n| a |\n|---|\n| 1 |\n===\n");
  const r = cli("style", "check", mf, content, "--json");
  assert.equal(r.code, 0, r.err);
  const b = JSON.parse(r.out).bindings.find((x) => x.block === "#t");
  assert.equal(b.box.width, "321px");
  assert.deepEqual(b.variants, []);
});

test("embed：没有 src= 的 embed 一条规则也不贡献，并说出原因", () => {
  const s = sheet("=== embed {#e}\n===\n");
  assert.deepEqual(codes(s.diagnostics), ["style-embed-not-expanded"]);
  assert.match(s.diagnostics[0].message, /no `src=`/);
});

test("embed：同文档内的 #id 引用把那一节再收一遍 —— 那一节里的自引用是环，报一次、不无限展开", () => {
  const s = sheet('# 基础 {#sec}\n\n=== style-rule {#r match="table" component=x}\n===\n\n=== embed {#e src="#sec"}\n===\n');
  assert.deepEqual(s.rules.map((r) => r.id), ["r", "r"]);
  assert.deepEqual(codes(s.diagnostics), ["style-embed-not-expanded"]);
  assert.match(s.diagnostics[0].message, /cycle/);
});

test("embed：目标文档是空的，也点名说出来", () => {
  w("empty.geml", "");
  const sh = w("emb-empty.geml", '=== meta\nprofile = "geml-style/v1"\n===\n\n=== embed {#e src="empty.geml"}\n===\n');
  const c = w("emb-c.geml", "=== table {#t}\n| a |\n|---|\n| 1 |\n===\n");
  const r = cli("style", "check", sh, c);
  assert.match(r.out + r.err, /the target is empty/);
});

test("embed：嵌套超过深度上限时停下并说出上限", () => {
  for (let i = 0; i <= 9; i++) {
    const next = i < 9
      ? `=== embed {#e src="deep${i + 1}.geml"}\n===\n`
      : '=== style-rule {#leaf match="table" component=x}\n===\n';
    w(`deep${i}.geml`, '=== meta\nprofile = "geml-style/v1"\n===\n\n' + next);
  }
  const c = w("deep-c.geml", "=== table {#t}\n| a |\n|---|\n| 1 |\n===\n");
  const r = cli("style", "check", p("deep0.geml"), c);
  assert.match(r.out + r.err, /deeper than 8/);
});

test("sitemap：不匹配的行被跳过，匹配的那行才加载", () => {
  w("sm-base.geml", '=== meta\nprofile = "geml-style/v1"\n===\n\n=== style-rule {#b match="table" component=base}\n===\n');
  w("sm-extra.geml", '=== meta\nprofile = "geml-style/v1"\n===\n\n=== style-rule {#x match="table" badge=extra}\n===\n');
  const c = w("smc.geml", "=== table {#t}\n| a |\n|---|\n| 1 |\n===\n");
  const mf = w("sm-man.geml", '=== meta\nprofile = "geml-style/v1"\ndefault-style = "sm-base.geml"\n===\n\n'
    + "=== table {#sitemap}\n| document | template |\n|---|---|\n| other.geml | nope.geml |\n| smc.geml | sm-extra.geml |\n===\n");
  const r = cli("style", "check", mf, c, "--json");
  assert.equal(r.code, 0, r.err);
  const b = JSON.parse(r.out).bindings.find((x) => x.block === "#t");
  assert.equal(b.params.component, "base");
  assert.equal(b.params.badge, "extra");
});

test("sitemap：只有一格的行当作没有指派；#sitemap 不是表时也当作没有指派", () => {
  const c = w("smc2.geml", "=== table {#t}\n| a |\n|---|\n| 1 |\n===\n");
  const mf = w("sm-man2.geml", '=== meta\nprofile = "geml-style/v1"\ndefault-style = "sm-base.geml"\n===\n\n'
    + "=== table {#sitemap}\n| document | template |\n|---|---|\n| smc2.geml |\n===\n");
  const r = cli("style", "check", mf, c, "--json");
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).bindings.find((x) => x.block === "#t").params.badge, undefined);

  const s = loadStylesheet(parse('=== meta\nprofile = "geml-style/v1"\n===\n\n=== text {#sitemap}\nnot a table\n===\n\n=== style-rule {#r match="table" component=x}\n===\n'), { forDoc: "c.geml" });
  assert.deepEqual(s.rules.map((r) => r.id), ["r"]);
  assert.deepEqual(codes(s.diagnostics), []);
});


// ---------------------------------------------------------------- frame 图的形状与安全边界（设计 §12.4）

test("frame：一个 frame 可以被多个槽位放置 —— 每处再渲染一遍，等于块点名两次，不是诊断", () => {
  const vm = resolve('=== style-screen {#s slots="#f, #f"}\n===\n\n=== style-frame {#f slots="table"}\n===\n');
  assert.deepEqual(codes(vm.diagnostics), []);
  assert.deepEqual(vm.screens[0].slots.map((x) => x.kind === "frame" ? x.frame : x.kind), ["f", "f"]);
  const two = resolve(
    '=== style-screen {#s slots="#f, #g"}\n===\n\n' +
    '=== style-frame {#g slots="#f"}\n===\n\n' +
    '=== style-frame {#f slots="table"}\n===\n'
  );
  assert.deepEqual(codes(two.diagnostics), []);
});

test("frame：一万多个 frame 串成的链不会打爆栈 —— 报一次 frame-too-deep，线性时间", () => {
  const N = 12000;
  let body = '=== style-screen {#s slots="#f0"}\n===\n';
  for (let i = 0; i < N; i++) body += `=== style-frame {#f${i} slots="${i + 1 < N ? `#f${i + 1}` : "table"}"}\n===\n`;
  const t0 = Date.now();
  const vm = resolve(body);
  const ms = Date.now() - t0;
  assert.ok(ms < 8000, `took ${ms}ms`);
  assert.deepEqual(codes(vm.diagnostics), ["frame-too-deep"]);
  assert.match(vm.diagnostics[0].message, /12000 deep at `#f11999`; the cap is 16/);
});

test("frame：四十层菱形（每层两个槽位指向同一个子 frame）线性走完，不是 2^40", () => {
  const K = 40;
  let body = '=== style-screen {#s slots="#f0, #f0"}\n===\n';
  for (let i = 0; i < K; i++) body += `=== style-frame {#f${i} slots="${i + 1 < K ? `#f${i + 1}, #f${i + 1}` : "table"}"}\n===\n`;
  const t0 = Date.now();
  const vm = resolve(body);
  const ms = Date.now() - t0;
  assert.ok(ms < 3000, `took ${ms}ms`);
  assert.deepEqual(codes(vm.diagnostics), ["frame-too-deep"]);
});

test("frame：深度取最长的那条放置路径 —— 浅处先到也挡不住深处的超限", () => {
  // #deep 从 screen 直接放（深度 1），也从 17 层链的末端放（深度 18）
  let body = '=== style-screen {#s slots="#deep, #c0"}\n===\n=== style-frame {#deep slots="table"}\n===\n';
  for (let i = 0; i < 17; i++) body += `=== style-frame {#c${i} slots="${i + 1 < 17 ? `#c${i + 1}` : "#deep"}"}\n===\n`;
  const vm = resolve(body);
  assert.deepEqual(codes(vm.diagnostics), ["frame-too-deep"]);
  assert.match(vm.diagnostics[0].message, /18 deep at `#deep`/);
});

test("frame：不挂在任何 screen 下的环也报出来；十六层以内不报深度", () => {
  const loose = resolve('=== style-frame {#a slots="#b"}\n===\n\n=== style-frame {#b slots="#a"}\n===\n');
  assert.ok(loose.diagnostics.some((d) => d.code === "frame-cycle"), JSON.stringify(loose.diagnostics));
  assert.equal(loose.diagnostics.some((d) => d.code === "frame-too-deep"), false);
  let body = '=== style-screen {#s slots="#f0"}\n===\n';
  for (let i = 0; i < 16; i++) body += `=== style-frame {#f${i} slots="${i + 1 < 16 ? `#f${i + 1}` : "table"}"}\n===\n`;
  assert.deepEqual(codes(resolve(body).diagnostics), []);
});


test("security: a state named __proto__ / constructor keeps its when= condition and pollutes nothing", () => {
  const before = Object.keys(Object.prototype).length;
  const vm = resolve(
    '=== style-state {#__proto__ type=scalar match="table#kpi" on=toggle init-value=open}\n===\n' +
    '=== style-state {#constructor type=scalar match="table#kpi" on=select init-value=a}\n===\n' +
    '=== style-rule {#r match="table#kpi" when="$__proto__=closed, $constructor=b" width=0}\n===\n',
  );
  const b = vm.bindings.find((x) => x.block === "#kpi");
  assert.equal(b.variants.length, 1);
  assert.deepEqual(Object.entries(b.variants[0].when).sort(), [["__proto__", "closed"], ["constructor", "b"]]);
  assert.equal(Object.getPrototypeOf(b.variants[0].when), null, "the when object has no prototype to clobber");
  assert.equal(Object.keys(Object.prototype).length, before);
  assert.deepEqual(vm.diagnostics.filter((d) => d.severity === "error"), []);
});


test("容器收内含词：screen 是页，它的 box 就是整页的样子；封闭值域照样校验", () => {
  const vm = resolve(
    '=== style-screen {#p axis=column background="#0d1117" padding=24px gap=16px slots="table"}\n===\n' +
    '=== style-frame {#f axis=row gap=8px border-radius=6px slots="table#kpi"}\n===\n');
  assert.deepEqual(vm.screens[0].box, { background: "#0d1117", padding: "24px", gap: "16px" });
  assert.deepEqual(vm.frames[0].box, { gap: "8px", "border-radius": "6px" });
  // 容器上的取值闸和块上是同一道
  const bad = resolve('=== style-screen {#p text-align=middle sticky=x slots="table"}\n===\n');
  assert.deepEqual(bad.diagnostics.filter((d) => d.code === "style-invalid-value").length, 2);
  // 真正不认识的键还是要报
  const unk = resolve('=== style-screen {#p bogus=1 slots="table"}\n===\n');
  assert.ok(unk.diagnostics.some((d) => d.code === "style-unknown-attribute"));
});

test("标题和散文是可放置节点：`geml list` 一直能寻址它们，选择器现在也看得见", () => {
  const doc = parse("# T {#h1 .doc}\n\nloose prose\n\n=== table {#kpi .doc format=csv}\na\n1\n===\n");
  const vmOf = (slots) => resolveStyle(sheet(`=== style-screen {#p slots="${slots}"}\n===\n`), [{ path: "d.geml", doc }]);
  assert.deepEqual(vmOf(".doc").screens[0].slots[0].blocks.map((b) => b.block), ["#h1", "#kpi"], "class 现在也落在标题上");
  assert.deepEqual(vmOf("heading").screens[0].slots[0].blocks.map((b) => b.block), ["#h1"]);
  assert.deepEqual(vmOf("prose").screens[0].slots[0].blocks.map((b) => b.block), ["[1]"], "段落没有 id，地址是文档序");
  assert.deepEqual(vmOf("heading[level=1]").screens[0].slots[0].blocks.map((b) => b.block), ["#h1"], "level 可选");
  // 块**内部**的段落不是文档的一节，不该被 prose 选中
  const inner = resolveStyle(sheet('=== style-screen {#p slots="prose"}\n===\n'),
    [{ path: "d.geml", doc: parse("=== text {#t}\npara one\n\npara two\n===\n") }]);
  assert.deepEqual(inner.screens[0].slots[0].blocks, []);
});

test("`*` 是整步才认的全选：一个槽位按文档顺序摆下整篇；半吊子写法照旧拒绝", () => {
  const doc = parse("# T {#h1}\n\nloose\n\n=== table {#kpi format=csv}\na\n1\n===\n");
  const vm = resolveStyle(sheet('=== style-screen {#p slots="*"}\n===\n'), [{ path: "d.geml", doc }]);
  assert.deepEqual(vm.screens[0].slots[0].blocks.map((b) => b.block), ["#h1", "[1]", "#kpi"]);
  assert.deepEqual(vm.diagnostics, []);
  for (const bad of ["*.kpi", "table.a*", "table > p", "p:first-child"]) {
    const r = resolveStyle(sheet(`=== style-rule {#r match="${bad}" color=red}\n===\n`), [{ path: "d.geml", doc }]);
    assert.ok(r.diagnostics.some((d) => d.code === "selector-unsupported"), bad);
  }
  // `table *` 仍是合法的后代选择器
  assert.deepEqual(
    resolveStyle(sheet('=== style-rule {#r match="table *" color=red}\n===\n'), [{ path: "d.geml", doc }])
      .diagnostics.filter((d) => d.code === "selector-unsupported"), []);
});

test("容器可以是组件并带参数：页面外壳属于样式表，不该塞进文档冒充块", () => {
  const vm = resolve('=== style-screen {#p component=bar items="Code · Issues" icon="M0 0h4" icon-size=20 padding=8px slots="table"}\n===\n');
  assert.equal(vm.screens[0].component, "bar");
  assert.deepEqual(vm.screens[0].params, { items: "Code · Issues", icon: "M0 0h4", "icon-size": 20 });
  assert.deepEqual(vm.screens[0].box, { padding: "8px" }, "内含词照旧进 box，不混进 params");
  assert.deepEqual(vm.diagnostics.filter((d) => d.severity === "error"), []);
  // `layout=` 仍然指路，不静默
  assert.ok(resolve('=== style-screen {#p layout=split slots="table"}\n===\n')
    .diagnostics.some((d) => d.code === "style-unknown-attribute" && /component=/.test(d.message)));
  // 未注册的组件名在给了注册表时报出来（宿主不传就不检查）
  const vm2 = resolveStyle(sheet('=== style-frame {#f component=nope slots="table"}\n===\n'
    + '=== style-screen {#p slots="#f"}\n===\n'), corpus1, { components: ["bar"] });
  assert.ok(vm2.diagnostics.some((d) => d.code === "unknown-component"), JSON.stringify(vm2.diagnostics));
});

// ---------------------------------------------------------------- 第二个页面用例（设计 2026-09-10）

test("内含词：axis 能挂块上、view/editable 闭域；域外报 style-invalid-value（设计 2026-09-10 §4b-d）", () => {
  const ok = sheet('=== style-rule {#r match="text#nav" axis=row view=source editable=yes}\n===\n');
  assert.deepEqual(ok.rules[0].box, { axis: "row", view: "source", editable: "yes" });
  assert.deepEqual(codes(ok.diagnostics), []);
  const bad = sheet('=== style-rule {#r match="text#nav" axis=diagonal view=raw editable=maybe}\n===\n');
  assert.deepEqual(codes(bad.diagnostics), ["style-invalid-value", "style-invalid-value", "style-invalid-value"]);
  assert.deepEqual(bad.rules[0].box, {});
});

test("收口：合并后没有 component= 接的参数报 warning；组件可以来自另一条规则（设计 2026-09-10 §4f + §4.3）", () => {
  const typo = resolve('=== style-rule {#r match="table.kpi" icon="x.svg" color=red}\n===\n');
  assert.deepEqual(codes(typo.diagnostics), ["style-unknown-attribute"]);
  assert.equal(typo.diagnostics[0].severity, "warning");
  assert.equal(typo.diagnostics[0].rule, "r");
  assert.match(typo.diagnostics[0].message, /`icon` on `c\.geml#kpi` has no `component=` to receive it \(set by #r\)/);
  assert.deepEqual(binding(typo, "#kpi").box, { color: "red" });
  assert.deepEqual(binding(typo, "#kpi").params, { icon: "x.svg" }, "值还在 —— 报的是没人读它，不是丢了它");
  const split = resolve('=== style-rule {#base match="table" component=data-table}\n===\n=== style-rule {#kpis match="table.kpi" badge="kpi"}\n===\n');
  assert.deepEqual(codes(split.diagnostics), [], "组件在 #base、参数在 #kpis：合并后有接收方");
  const two = resolve('=== style-rule {#a match="table.kpi" icon=x}\n===\n=== style-rule {#b match="table.kpi" when="$s=1" shortcut=T}\n===\n=== style-state {#s type=scalar match="table.kpi" on=toggle}\n===\n');
  assert.deepEqual(codes(two.diagnostics), ["style-unknown-attribute"], "基础组和变体组的野键合成一条");
  assert.match(two.diagnostics[0].message, /`icon`, `shortcut` on `c\.geml#kpi` have no `component=` to receive them \(set by #a, #b\)/);
  const load = sheet('=== style-rule {#r match="table" icon="x.svg"}\n===\n');
  assert.deepEqual(codes(load.diagnostics), [], "装载期不判：那时还不知道合并结果");
});

test("部件规则：只收对一段行内说得通的内含词，其余报 style-unknown-attribute 并丢弃", () => {
  const s = sheet('=== style-rule {#r match="text#nav link" color="#0969da" padding="4px 6px" sticky=0 grow=yes}\n===\n');
  assert.deepEqual(codes(s.diagnostics), ["style-unknown-attribute", "style-unknown-attribute"]);
  assert.match(s.diagnostics[0].message, /not a word for an inline part/);
  assert.deepEqual(s.rules[0].box, { color: "#0969da", padding: "4px 6px" });
});

test("部件绑定：binding 带 part；块规则与部件规则不争；两条部件规则争同一属性照旧 ambiguous-rule", () => {
  const corpus = [{ path: "p.geml", doc: parse('=== text {#nav}\n- [Code](https://x) `1`\n===\n\n=== text {#nolink}\nplain\n===\n') }];
  const vm = resolveStyle(sheet(
    '=== style-rule {#blk match="text#nav" color=black}\n===\n' +
    '=== style-rule {#lnk match="text#nav link" color=blue}\n===\n' +
    '=== style-rule {#pill match="text#nav code-span" background=grey}\n===\n' +
    '=== style-rule {#miss match="text#nolink link" color=red}\n===\n'
  ), corpus);
  const nav = vm.bindings.filter((b) => b.block === "#nav");
  assert.deepEqual(nav.map((b) => b.part ?? "(block)").sort(), ["(block)", "code-span", "link"]);
  assert.equal(nav.find((b) => b.part === undefined).box.color, "black");
  assert.equal(nav.find((b) => b.part === "link").box.color, "blue");
  assert.equal(nav.find((b) => b.part === "code-span").box.background, "grey");
  assert.deepEqual(codes(vm.diagnostics), ["unmatched-rule"], "#miss 没命中：#nolink 里没有链接");
  const clash = resolveStyle(sheet(
    '=== style-rule {#a match="text#nav link" color=blue}\n===\n' +
    '=== style-rule {#b match="text#nav link" color=red}\n===\n'
  ), corpus);
  assert.deepEqual(codes(clash.diagnostics), ["ambiguous-rule"]);
});

test("when=@hover：内建伪状态进条件集；与 $state 并列；@focus 与 @hover 争同一属性是 ambiguous-rule（设计 2026-09-10 §4e）", () => {
  const corpus = [{ path: "p.geml", doc: parse('=== text {#nav}\n- [a](https://a)\n===\n') }];
  const vm = resolveStyle(sheet(
    '=== style-state {#side type=scalar match="text#nav" on=toggle init-value=open}\n===\n' +
    '=== style-rule {#base match="text#nav link" color=black}\n===\n' +
    '=== style-rule {#hov match="text#nav link" when="@hover" color=blue}\n===\n' +
    '=== style-rule {#both match="text#nav link" when="$side=closed, @hover" color=red}\n===\n'
  ), corpus);
  assert.deepEqual(codes(vm.diagnostics), []);
  const link = vm.bindings.find((b) => b.block === "#nav" && b.part === "link");
  assert.equal(link.box.color, "black");
  assert.deepEqual(link.variants.map((v) => v.when), [W({ "@hover": "true" }), W({ side: "closed", "@hover": "true" })], "条件数升序；@hover 算一项");
  const clash = resolveStyle(sheet(
    '=== style-rule {#h match="text#nav link" when="@hover" color=blue}\n===\n' +
    '=== style-rule {#f match="text#nav link" when="@focus" color=red}\n===\n'
  ), corpus);
  assert.deepEqual(codes(clash.diagnostics), ["ambiguous-rule"], "可以同时成立、互不包含、争同一属性");
  const typo = sheet('=== style-rule {#h match="text#nav" when="@hoover" color=blue}\n===\n');
  assert.deepEqual(codes(typo.diagnostics), ["style-invalid-value"]);
  assert.match(typo.diagnostics[0].message, /@hover/);
  assert.match(typo.diagnostics[0].message, /@focus/);
  const inj = sheet('=== style-rule {#h match="text#nav" when="@hover} body{display:none" color=blue}\n===\n');
  assert.deepEqual(codes(inj.diagnostics), ["style-invalid-value"]);
});

test("layer=screen 与 fade-out：闭域多一个成员、时间轴多一个词，域外值各报 style-invalid-value", () => {
  const ok = sheet('=== style-frame {#splash layer=screen fade-out=1 slots="text#x"}\n===\n');
  assert.deepEqual(ok.frames[0].box, { layer: "screen", "fade-out": 1 });
  assert.deepEqual(codes(ok.diagnostics), []);
  const zero = sheet('=== style-rule {#r match="text#x" fade-out=0}\n===\n');
  assert.deepEqual(zero.rules[0].box, { "fade-out": 0 }, "0 是合法的：不淡");
  for (const [attr, re] of [
    ["layer=window", /is not `page`, `overlay` or `screen`/],
    ["fade-out=soon", /must be a number of seconds between 0 and 60/],
    ["fade-out=-1", /between 0 and 60/],
    ["fade-out=600", /between 0 and 60/],
  ]) {
    const bad = sheet(`=== style-rule {#r match="text#x" ${attr}}\n===\n`);
    assert.deepEqual(codes(bad.diagnostics), ["style-invalid-value"], attr);
    assert.match(bad.diagnostics[0].message, re, attr);
    assert.deepEqual(bad.rules[0].box, {}, attr);
  }
});

test("underline：闭域 yes/no，块和部件都收；域外值报 style-invalid-value", () => {
  const ok = sheet('=== style-rule {#r match="text#nav link" underline=no}\n===\n');
  assert.deepEqual(ok.rules[0].box, { underline: "no" });
  assert.deepEqual(codes(ok.diagnostics), [], "部件上说得通 —— 一段文字带不带下划线");
  const onBlock = sheet('=== style-rule {#r match="text#nav" underline=yes}\n===\n');
  assert.deepEqual(onBlock.rules[0].box, { underline: "yes" });
  const bad = sheet('=== style-rule {#r match="text#nav link" underline=dotted}\n===\n');
  assert.deepEqual(codes(bad.diagnostics), ["style-invalid-value"]);
  assert.match(bad.diagnostics[0].message, /is not `yes` or `no`/);
  assert.deepEqual(bad.rules[0].box, {});
});

test("槽位不摆部件：slots 里写部件选择器是 selector-unsupported", () => {
  const vm = resolveStyle(sheet('=== style-screen {#p slots="text#nav link"}\n===\n'),
    [{ path: "p.geml", doc: parse('=== text {#nav}\n- [a](https://a)\n===\n') }]);
  assert.ok(vm.diagnostics.some((d) => d.code === "selector-unsupported" && /slot places blocks/.test(d.message)), JSON.stringify(vm.diagnostics));
});

test("记号：属性里的 {{key}} 按本文件 meta 代换（设计 §13.13）", () => {
  const s = loadStylesheet(parse(
    '=== meta\nprofile = "geml-style/v1"\nline = "#d1d9e0"\npad = "8px"\n===\n\n' +
    '=== style-rule {#r match="text" border="1px solid {{line}}" padding="{{pad}}"}\n===\n'));
  assert.deepEqual(codes(s.diagnostics), []);
  assert.deepEqual(s.rules[0].box, { border: "1px solid #d1d9e0", padding: "8px" });
});

test("记号：整个值就是一个记号时带上类型，数值域的内含词才喂得进去", () => {
  const s = loadStylesheet(parse(
    '=== meta\nprofile = "geml-style/v1"\ncol = 1012\n===\n\n' +
    '=== style-rule {#r match="text" hide-below="{{col}}" max-width="{{col}}px"}\n===\n'));
  assert.deepEqual(codes(s.diagnostics), [], "1012 是数字，hide-below 收得下");
  assert.deepEqual(s.rules[0].box, { "hide-below": 1012, "max-width": "1012px" });
});

test("记号：悬空的 {{key}} 是 error，原文留着不静默换空串", () => {
  const s = loadStylesheet(parse(
    '=== meta\nprofile = "geml-style/v1"\nline = "#d1d9e0"\n===\n\n' +
    '=== style-rule {#r match="text" color="{{nope}}" border="1px solid {{line}}"}\n===\n'));
  assert.deepEqual(codes(s.diagnostics), ["unknown-token"]);
  assert.equal(STYLE_SEVERITY["unknown-token"], "error");
  assert.match(s.diagnostics[0].message, /`\{\{nope\}\}` in `color=`/);
  assert.equal(s.rules[0].box.color, "{{nope}}");
  assert.equal(s.rules[0].box.border, "1px solid #d1d9e0", "同一条规则里认识的那个照常代换");
});

test("记号：match= 里也代换 —— 属性值一视同仁，没有开洞", () => {
  const s = loadStylesheet(parse(
    '=== meta\nprofile = "geml-style/v1"\nwhich = "text#nav"\n===\n\n' +
    '=== style-rule {#r match="{{which}}" color="#000000"}\n===\n'));
  assert.deepEqual(codes(s.diagnostics), []);
  assert.equal(s.rules[0].branches[0].source, "text#nav");
});

test("记号：embed 进来的规则用它自己那份文件的 meta，不用宿主的", () => {
  const other = '=== meta\nprofile = "geml-style/v1"\nline = "#00ff00"\n===\n\n' +
                '=== style-rule {#theirs match="note" color="{{line}}"}\n===\n';
  const s = loadStylesheet(
    parse('=== meta\nprofile = "geml-style/v1"\nline = "#ff0000"\n===\n\n' +
          '=== embed {#e src="other.geml"}\n===\n\n' +
          '=== style-rule {#mine match="table" color="{{line}}"}\n===\n'),
    { loadDoc: (path) => (path === "other.geml" ? other : null), parseDoc: (src) => parse(src) });
  assert.deepEqual(codes(s.diagnostics), []);
  const by = Object.fromEntries(s.rules.map((r) => [r.id, r.box.color]));
  assert.deepEqual(by, { theirs: "#00ff00", mine: "#ff0000" });
});

test("简写与单边：同层两条规则一个写 border、一个写某边 → ambiguous-rule", () => {
  const doc = parse("=== text {#a}\nhi\n===\n");
  const first =
    '=== style-rule {#one match="text" border="1px solid red"}\n===\n\n' +
    '=== style-rule {#two match="text#a" border-left="0"}\n===\n';
  // 同样两条规则，只换文件里的先后 —— 两次都必须报，否则渲染就取决于源码顺序
  const flipped =
    '=== style-rule {#two match="text#a" border-left="0"}\n===\n\n' +
    '=== style-rule {#one match="text" border="1px solid red"}\n===\n';
  for (const [name, body] of [["原序", first], ["互换", flipped]]) {
    const d = resolveStyle(sheet(body), [{ path: "p.geml", doc }])
      .diagnostics.filter((x) => x.code === "ambiguous-rule");
    assert.equal(d.length, 1, name);
    assert.match(d[0].message, /a shorthand and one of its sides in the same layer/, name);
  }
});

test("简写与单边：写进同一条规则、或两条都是单边 —— 都放行", () => {
  const doc = parse("=== text {#a}\nhi\n===\n");
  const run = (body) => codes(resolveStyle(sheet(body), [{ path: "p.geml", doc }]).diagnostics);
  assert.deepEqual(run('=== style-rule {#r match="text#a" border="1px solid red" border-left="0"}\n===\n'),
    [], "一条规则里的先后是作者自己写的，geml set 换的是整块");
  assert.deepEqual(run(
    '=== style-rule {#one match="text" border-top="1px solid red"}\n===\n\n' +
    '=== style-rule {#two match="text#a" border-left="0"}\n===\n'),
    [], "两个单边互不覆盖，没有先后可言");
  assert.deepEqual(run(
    '=== style-rule {#one match="text" border-radius="6px"}\n===\n\n' +
    '=== style-rule {#two match="text#a" border-left="0"}\n===\n'),
    [], "border-radius 不在这一族里");
});

console.log(`\n${passed} passed`);
