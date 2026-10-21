// geml-statechart/v1：一个 diagram 块里的状态机。profile §3 的检查钉在
// spec/profiles/geml-statechart/checks.json，这里逐例重放；模型、人话与 Mermaid
// 投影另有几条单测。
import { parse, renderHtml, gemlToMd } from "../dist/geml.js";
import { statechartDiagram } from "../dist/statechart-render.js";
import { checkStatechart, statechartsOf } from "../dist/statechart-check.js";
import { buildStatechart, edgeLabel, guardText, holds, mermaidOf, readsOf, schemaProblems } from "../dist/statechart.js";
import { flowOf, layoutOf, pillsOf, ranksOf, statechartSvg, statechartSvgDataUrl, wrapLabel } from "../dist/statechart-svg.js";
import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

/** 一个只认内存里几份文件的 ProfileIO。 */
const ioOf = (files) => ({ readDoc: (rel) => files[rel] ?? null, hashFile: () => null, hashText: () => "" });
const codesOf = (ds) => ds.map((d) => `${d.severity}:${d.code}`).sort();

const table = JSON.parse(readFileSync(new URL("../../spec/profiles/geml-statechart/checks.json", import.meta.url), "utf8"));
for (const c of table.cases) {
  test(`checks.json: ${c.name}`, () => {
    const got = checkStatechart("case.geml", ioOf({ "case.geml": c.geml, ...(c.files ?? {}) }));
    assert.deepEqual(codesOf(got), c.codes, got.map((d) => d.message).join("\n"));
    for (const d of got) { assert.equal(d.doc, "case.geml"); assert.equal(d.id, "m"); }
  });
}

const ORDER = readFileSync(new URL("./fixtures/statechart-order.geml", import.meta.url), "utf8");

test("订单流程：五个状态、七个条件变量、五条转换，终点是 done，每条转换知道自己读哪些变量", () => {
  const [{ result }] = statechartsOf(parse(ORDER), "flow.geml", () => null);
  assert.deepEqual(result.diagnostics, []);
  const m = result.model;
  assert.equal(m.initial, "order");
  assert.deepEqual(m.states.map((s) => s.id), ["order", "verify", "packed", "shipped", "done"]);
  assert.equal(m.states[0].title, "下单");
  assert.deepEqual(m.states[0].attrs.teams, ["sales", "billing", "stock"], "the program's keys stay on the node, as written");
  assert.deepEqual(m.vars.map((v) => v.name).length, 7);
  assert.deepEqual(m.vars[0].attrs.feed, { system: "warehouse" });
  assert.deepEqual(m.finals, ["done"]);
  assert.deepEqual(m.transitions.map((t) => t.name), ["order→verify", "verify→order", "verify→packed", "packed→shipped", "shipped→done"]);
  assert.deepEqual(m.transitions[0].reads, ["manual-check", "paid-ok", "risk-pass", "stock-held"], "anyOf is read through every branch");
  assert.equal(m.transitions[1].guard.kind, "text");
  assert.deepEqual(m.transitions[1].resets, ["stock-held", "manual-check"]);
  assert.equal(m.transitions[3].attrs.approval, true);
});

test("边上的字与人话：机器判的写它读的变量，一句话写原文，const / enum 读成 = 与 ∈", () => {
  const { model } = buildStatechart({ body: JSON.stringify({
    initial: "a", states: { a: {}, b: {} }, vars: { reviewed: { default: false }, approvals: { default: 0 } },
    transitions: [
      { from: "a", to: "b", guard: { properties: { reviewed: { const: true }, approvals: { enum: [2, 3] } } } },
      { from: "a", to: "b", guard: "买家申请退款" },
      { from: "a", to: "b", guard: { anyOf: [{ properties: { reviewed: { const: true } } }, { required: ["approvals"] }] } },
    ] }), attrs: {} });
  assert.equal(edgeLabel(model.transitions[0]), "approvals, reviewed");
  assert.equal(guardText(model.transitions[0].guard), "reviewed = true and approvals ∈ {2, 3}");
  assert.equal(edgeLabel(model.transitions[1]), "买家申请退款");
  assert.equal(model.transitions[1].name, "a→b[2]", "the second transition of a pair is numbered");
  assert.equal(guardText(model.transitions[2].guard), "(reviewed = true or approvals)");
});

test("Mermaid 投影：起点、终点、别名与标签；# 与 : 不进标签", () => {
  const [{ result }] = statechartsOf(parse(ORDER), "flow.geml", () => null);
  const mm = mermaidOf(result.model);
  assert.ok(mm.startsWith("stateDiagram-v2\n"));
  assert.ok(mm.includes('    state "下单" as order\n'), "a title becomes an alias line");
  assert.ok(mm.includes("    [*] --> order\n"));
  assert.ok(mm.includes("    order --> verify : manual-check, paid-ok, risk-pass, stock-held\n"));
  assert.ok(mm.includes("    verify --> order : verify 要求改单\n"));
  assert.ok(mm.endsWith("    done --> [*]"));
  const { model } = buildStatechart({ body: '{ "initial": "wait-human", "states": { "wait-human": {} }, "transitions": [] }', attrs: {} });
  assert.ok(mermaidOf(model).includes('state "wait-human" as s0'), "an id Mermaid cannot take gets an alias");
});

test("子集校验与求值：minimum 被拒，const / enum / anyOf / required 按值判", () => {
  assert.deepEqual(schemaProblems({ properties: { x: { const: true } } }, "g"), []);
  assert.equal(schemaProblems({ properties: { x: { minimum: 1 } } }, "g").length, 1);
  assert.equal(schemaProblems({ anyOf: [{}] }, "g").length, 1, "anyOf needs two branches");
  assert.equal(schemaProblems({ type: "boolean", const: 1 }, "g").length, 1, "const must fit type");
  const g = { anyOf: [{ properties: { a: { const: true }, b: { const: true } } }, { required: ["c"] }] };
  assert.deepEqual(readsOf(g), ["a", "b", "c"]);
  assert.equal(holds(g, { a: true, b: true }), true);
  assert.equal(holds(g, { a: true, b: false }), false);
  assert.equal(holds(g, { a: false, b: false, c: 1 }), true);
  assert.equal(holds({ properties: { n: { enum: [2, 3] } } }, { n: 3 }), true);
  assert.equal(holds({ properties: { n: { enum: [2, 3] } } }, { n: 4 }), false);
  assert.equal(holds({ oneOf: [{ required: ["a"] }, { required: ["b"] }] }, { a: 1, b: 2 }), false, "oneOf: exactly one");
});

test("geml check 报 statechart-* 码，按块 id 报", () => {
  const src = '=== meta\nprofile = "geml-statechart/v1"\n===\n\n=== diagram {#flow format=geml-statechart}\n{ "initial": "x", "states": { "a": {} }, "transitions": [] }\n===\n';
  const got = checkStatechart("flow.geml", ioOf({ "flow.geml": src }));
  assert.deepEqual(got.map((d) => [d.code, d.id]), [["statechart-initial", "flow"]]);
});

test("--to html：注册了渲染器就画自己的 SVG、给出下载链接并列出状态与转换；页面不再引 Mermaid；没注册就是源码块", () => {
  const html = renderHtml(parse(ORDER), { diagrams: { "geml-statechart": statechartDiagram } });
  assert.ok(html.includes('<figure class="statechart" id="flow"><svg class="geml-statechart" xmlns="http://www.w3.org/2000/svg"'), "the picture is the parser's own SVG");
  assert.ok(html.includes('<text class="ttl" x="24" y="42">订单流程</text>'), "the caption is drawn inside the picture, so the file carries it");
  assert.ok(html.includes('<p class="statechart-tools"><a download="flow.svg" href="data:image/svg+xml;charset=utf-8,'), "the same SVG is offered as a file");
  assert.ok(html.includes('id="flow-arr"'), "markers are keyed by the block id");
  assert.ok(html.includes('<details class="statechart-state"><summary>下单 <code>order</code> <small>initial</small></summary>'), "each state opens on its attributes");
  assert.ok(html.includes('<dt>teams</dt><dd>["sales","billing","stock"]</dd>'), "the program's keys are shown as written");
  assert.ok(html.includes('<details class="statechart-transition"><summary><code>packed→shipped</code></summary><p><b>guard</b> carrier-assigned = true</p>'), "a transition opens on its guard read out");
  assert.ok(html.includes("<dt>approval</dt><dd>true</dd>"));
  assert.ok(!html.includes("mermaid.esm.min.mjs"), "no Mermaid runtime: the picture needs none");
  const bare = renderHtml(parse(ORDER));
  assert.ok(bare.includes('class="diagram-src" data-format="geml-statechart"'), "unregistered: §7's labelled source");
  const dataForm = renderHtml(parse('=== data {#def format=json}\n{ "initial": "a", "states": { "a": { "title": "甲" }, "b": { "final": true } }, "transitions": [ { "from": "a", "to": "b" } ] }\n===\n\n=== diagram {#g format=geml-statechart data=#def current=b}\n===\n'), { diagrams: { "geml-statechart": statechartDiagram } });
  assert.ok(dataForm.includes('class="node final cur"') && dataForm.includes("<small>final, current</small>"), "the definition in a data block is found through the document, and current= is drawn");
  const broken = renderHtml(parse('=== diagram {format=geml-statechart}\n{ "initial": "x", "states": {}, "transitions": [] }\n===\n'), { diagrams: { "geml-statechart": statechartDiagram } });
  assert.ok(broken.includes('<p class="render-error">geml-statechart: `initial` names `x`, which is not a state</p>'));
});

test("--to md：投影成 Mermaid 围栏；data= 的形式退化为描述符并记一条 note", () => {
  const { md, notes } = gemlToMd(parse(ORDER));
  assert.ok(md.includes("```mermaid\nstateDiagram-v2\n"), md.slice(0, 400));
  assert.ok(md.includes("    order --> verify : manual-check, paid-ok, risk-pass, stock-held\n"));
  assert.deepEqual(notes.filter((n) => n.includes("statechart")), []);
  const viaData = gemlToMd(parse('=== data {#def format=json}\n{}\n===\n\n=== diagram {format=geml-statechart data=#def}\n===\n'));
  assert.ok(viaData.md.includes("```geml-statechart\ndata=#def\n```"));
  assert.equal(viaData.notes.length, 1);
});

test("SVG 画法：按最长路径分层、从左到右；回边走下方车道；条件做成胶囊，长的折两行；标志属性跟在后面；当前态有光环，起点有圆点，终点双框", () => {
  const [{ result }] = statechartsOf(parse(ORDER), "flow.geml", () => null);
  const m = result.model;
  assert.deepEqual([...ranksOf(m)], [["order", 0], ["verify", 1], ["packed", 2], ["shipped", 3], ["done", 4]]);
  const L = layoutOf(m, "订单流程");
  const kinds = Object.fromEntries(L.edges.map((e) => [e.t.name, e.kind]));
  assert.deepEqual(kinds, { "order→verify": "forward", "verify→order": "lane", "verify→packed": "forward", "packed→shipped": "forward", "shipped→done": "forward" });
  const xs = m.states.map((s) => L.nodes.get(s.id).x);
  assert.ok(xs.every((x, i) => i === 0 || x > xs[i - 1]), "ranks run left to right");
  const back = L.edges.find((e) => e.t.name === "verify→order");
  assert.ok(back.py > L.nodes.get("order").y + L.nodes.get("order").h, "the back edge's pill sits below the nodes");
  const fwd = L.edges.find((e) => e.t.name === "order→verify");
  assert.ok(fwd.py < L.nodes.get("order").y, "a forward edge's pill sits above the node band");
  assert.deepEqual(pillsOf(m.transitions[0]).map((p) => p.lines), [["manual-check, paid-ok", "risk-pass, stock-held"]], "a long guard wraps at a comma");
  assert.deepEqual(pillsOf(m.transitions.find((t) => t.name === "packed→shipped")).map((p) => [p.kind, p.lines[0]]), [["guard", "carrier-assigned"], ["attr", "approval"]], "a true flag is a pill; the note string is not");
  assert.deepEqual(pillsOf(m.transitions.find((t) => t.name === "verify→order")).map((p) => p.kind), ["sentence"], "a sentence guard is drawn as prose, its judge left to the program");
  assert.deepEqual(wrapLabel("short"), ["short"]);
  assert.deepEqual(wrapLabel("a-very-long-variable-name-without-any-break-in-it"), ["a-very-long-variable-nam", "e-without-any-break-in-…"], "no comma or space: cut hard and clip the rest");

  const svg = statechartSvg(m, { title: "订单流程", key: "flow" });
  assert.ok(svg.startsWith('<svg class="geml-statechart" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '));
  assert.ok(svg.includes('<g class="node initial" data-state="order">') && svg.includes('<g class="node final" data-state="done">'));
  assert.ok(svg.includes('<circle cx=') && svg.includes('<rect class="inner"'), "the start dot and the final state's inner border");
  assert.ok(!svg.includes('class="ring"'), "no current state, no ring");
  assert.ok(svg.includes('<g class="tr lane" data-transition="verify→order">') && svg.includes('class="flow lane"'), "the back edge runs in a lane with the slower flow");
  assert.ok(svg.includes("@keyframes sc-flow") && svg.includes("prefers-reduced-motion"), "motion is the picture's own, and optional");
  assert.ok(svg.includes("<title>verify→order — verify 要求改单</title>"), "a transition's tooltip reads the guard");
  assert.ok(statechartSvgDataUrl(svg).startsWith("data:image/svg+xml;charset=utf-8,%3Csvg"));

  const cur = buildStatechart({ body: JSON.stringify({ initial: "a", states: { a: {}, b: { final: true } }, transitions: [{ from: "a", to: "b", note: "a sentence for people" }, { from: "a", to: "a", guard: "again" }] }), attrs: { current: "a" } }).model;
  const s2 = statechartSvg(cur);
  assert.ok(s2.includes("<title>a→b\nnote: a sentence for people</title>"), "a prose attribute is in the tooltip, not on a pill");
  assert.ok(!s2.includes(">note"), "no pill for it");
  assert.ok(s2.includes('<g class="node initial cur" data-state="a">') && s2.includes('<rect class="ring"'), "current= fills and rings the state");
  assert.ok(s2.includes('<g class="tr self" data-transition="a→a[1]">') || s2.includes('data-transition="a→a"'), "a self-transition loops under its state");
  assert.ok(s2.includes("#a · current") && s2.includes("#b · final"));
  const island = buildStatechart({ body: JSON.stringify({ initial: "a", states: { a: {}, x: {}, y: {} }, transitions: [{ from: "x", to: "y" }, { from: "y", to: "x" }] }), attrs: {} }).model;
  assert.ok(island !== null && statechartSvg(island).includes('data-state="y"'), "states the start cannot reach are still drawn, a cycle among them included");
});

test("竖排与叠加：direction=down 把列变成行、车道在右边并让开最宽的胶囊；overlay 给出当前态、条件是否满足、各态的工作项数、暂停与刚走过的边；胶囊比列宽时整体右移", () => {
  const [{ result }] = statechartsOf(parse(ORDER), "flow.geml", () => null);
  const m = result.model;
  const L = layoutOf(m, { direction: "down" });
  const ys = m.states.map((s) => L.nodes.get(s.id).y);
  assert.ok(ys.every((y, i) => i === 0 || y > ys[i - 1]), "ranks run top to bottom");
  assert.equal(new Set(m.states.map((s) => { const n = L.nodes.get(s.id); return Math.round(n.x + n.w / 2); })).size, 1, "one state per rank: one column, centred");
  const lane = L.edges.find((e) => e.kind === "lane");
  const order = L.nodes.get("order");
  assert.ok(lane.px > order.x + order.w, "the lane runs to the right of the band");
  const wide = L.edges.find((e) => e.t.name === "order→verify");
  assert.ok(lane.px - 12 > wide.px + wide.pills.reduce((a, p) => a + p.w, 0) / 2, "past the widest pill in the band");
  assert.ok(L.shiftX > 0, "a pill wider than the column moves the picture right");
  const svg = statechartSvg(m, { direction: "down", overlay: { current: "verify", holds: { "verify→packed": false, "verify→order": true }, counts: { order: 2, verify: 1 }, paused: true, taken: ["order→verify"] } });
  assert.ok(svg.includes('<g class="sc" transform="translate('), "the shift is one transform");
  assert.ok(svg.includes('class="node cur" data-state="verify"') && svg.includes("#verify · paused"), "the overlay's state wins and says it is held");
  assert.ok(svg.includes('<g class="pill guard no">'), "a guard that does not hold is grey");
  assert.ok(!svg.includes('class="pill sentence ok"') && !svg.includes('class="pill sentence no"'), "a sentence has no value to show");
  assert.ok(svg.includes('<g class="badge">') && svg.includes(">2</text>"), "two items in #order get a badge");
  assert.ok(!svg.includes(">1</text></g>"), "the one item in the current state needs none");
  assert.ok(svg.includes('<g class="tr forward taken" data-transition="order→verify">') && svg.includes("url(#sc-arr-a)"), "the transition last taken is drawn in the accent");
  assert.ok(statechartSvg(m, { overlay: { holds: { "verify→packed": true } } }).includes('<g class="pill guard ok">'), "a guard that holds is green");
  const press = statechartSvg(m, { overlay: { current: "verify", pressable: ["verify→order"] } });
  assert.ok(press.includes('<g class="tr lane can" data-transition="verify→order" data-from="verify" data-to="order" role="button"><title>verify→order — verify 要求改单\n— press to take</title><path class="hit"'), "a pressable transition says where it goes and gets a wide stroke to hit");
  assert.ok(!press.includes('data-transition="verify→packed" data-from'), "the others carry no target");
});

test("flowOf：没有像素的拓扑——状态按层、每条边的种类、条件标签、谁判、标志——给用自己的元素画图的宿主", () => {
  const [{ result }] = statechartsOf(parse(ORDER), "flow.geml", () => null);
  const f = flowOf(result.model);
  assert.deepEqual(f.ranks, [["order"], ["verify"], ["packed"], ["shipped"], ["done"]]);
  assert.deepEqual(f.edges.map((e) => [e.name, e.kind]), [["order→verify", "forward"], ["verify→order", "lane"], ["verify→packed", "forward"], ["packed→shipped", "forward"], ["shipped→done", "forward"]], "the kinds the SVG draws, in the model's order");
  const back = f.edges.find((e) => e.name === "verify→order");
  assert.deepEqual([back.label, back.sentence, back.marks], ["verify 要求改单", true, []], "a sentence guard");
  const rel = f.edges.find((e) => e.name === "packed→shipped");
  assert.deepEqual([rel.label, rel.sentence, rel.marks], ["carrier-assigned", false, ["approval"]], "a schema guard's variables, and the true flag after it");
  const two = buildStatechart({ body: JSON.stringify({ initial: "a", states: { a: {}, b: {}, c: { final: true } }, transitions: [{ from: "a", to: "b" }, { from: "a", to: "c" }, { from: "b", to: "c" }, { from: "b", to: "b", guard: "again" }] }), attrs: {} }).model;
  const g = flowOf(two);
  assert.deepEqual(g.ranks, [["a"], ["b"], ["c"]]);
  assert.deepEqual(g.edges.map((e) => [e.name, e.kind, e.label]), [["a→b", "forward", ""], ["a→c", "lane", ""], ["b→c", "forward", ""], ["b→b", "self", "again"]], "an edge over a rank is a lane; one to its own state a self");
});

test("§4: a state id written in NFD is a NAME (profile §4 reads GEML §4), so the model keeps it as written and nothing is reported", () => {
  const src = "=== meta\nprofile = \"geml-statechart/v1\"\n===\n\n=== diagram {#m format=geml-statechart}\n{ \"initial\": \"Cafe\u0301\", \"states\": { \"Cafe\u0301\": {}, \"done\": { \"final\": true } }, \"transitions\": [ { \"from\": \"Cafe\u0301\", \"to\": \"done\" } ] }\n===\n";
  const [{ result }] = statechartsOf(parse(src), "m.geml", () => null);
  assert.deepEqual(result.diagnostics, [], result.diagnostics.map((d) => d.message).join("\n"));
  assert.deepEqual(result.model.states.map((s) => s.id), ["Cafe\u0301", "done"]);
});

console.log(`\n${passed} passed`);
