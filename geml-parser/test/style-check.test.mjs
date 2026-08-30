// geml-style 样式表的装载、求解与视图模型（设计 §4/§5/§7）。
import { parse } from "../dist/geml.js";
import { loadStylesheet, resolveStyle } from "../dist/style-resolve.js";
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

console.log(`\n${passed} passed`);
