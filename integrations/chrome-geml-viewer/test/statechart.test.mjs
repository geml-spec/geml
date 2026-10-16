// geml-statechart in the viewer (src/render.js): the parser's own SVG, inline,
// a download link for the same file, then a <details> per state and per
// transition. No Mermaid, no network — the picture is built from the model.
//
// Pure: parse() from the reference parser + linkedom for a document, exactly
// like chart.test.mjs.
import { parse } from "../../../geml-parser/dist/geml.js";
import { renderDocument } from "../src/render.js";
import { parseHTML } from "linkedom";
import { strict as assert } from "node:assert";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

function render(src) {
  const { document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
  return renderDocument(parse(src), document);
}

const FLOW = `=== meta
profile = "geml-statechart/v1"
===

=== diagram {#order format=geml-statechart caption="订单" current=paid}
{
  "initial": "new",
  "states": { "new": { "title": "新建" }, "paid": { "title": "已付款", "owner": "finance" }, "done": { "title": "完成", "final": true } },
  "transitions": [
    { "from": "new", "to": "paid", "guard": { "properties": { "paid": { "const": true } } } },
    { "from": "paid", "to": "new", "guard": "退款了" },
    { "from": "paid", "to": "done", "guard": { "properties": { "shipped": { "const": true } } }, "approval": true }
  ],
  "vars": { "paid": { "default": false }, "shipped": { "default": false } }
}
===
`;

test("a statechart block draws the parser's SVG, offers it as a file, and lists its states and transitions", () => {
  const root = render(FLOW);
  const fig = root.querySelector("figure.statechart");
  assert.ok(fig, "a figure for the block");
  assert.equal(fig.id, "order");
  const svg = fig.querySelector(".statechart-picture svg.geml-statechart");
  assert.ok(svg, "the picture is inline SVG");
  assert.ok(svg.querySelector('g.node.cur[data-state="paid"] rect.ring'), "current= is ringed");
  assert.ok(svg.querySelector('g.node.final[data-state="done"] rect.inner'), "a final state has the inner border");
  assert.equal(svg.querySelectorAll("g.tr").length, 3, "one edge per transition");
  assert.ok(svg.querySelector("g.tr.lane"), "the way back runs in a lane");
  // The edges within the band are drawn first, the lanes after them, so the pills come in that order.
  const pills = [...svg.querySelectorAll("g.pill text")].map((t) => t.textContent);
  assert.deepEqual(pills, ["paid", "shipped", "approval", "退款了"], "guard pills, then the true flag; the lane's last");
  assert.ok(svg.querySelector("text.ttl") && svg.querySelector("text.ttl").textContent === "订单", "the caption is in the picture");
  assert.ok(!fig.querySelector(".geml-mermaid"), "no Mermaid placeholder");
  const link = fig.querySelector(".statechart-tools a");
  assert.equal(link.getAttribute("download"), "order.svg");
  assert.ok(link.getAttribute("href").startsWith("data:image/svg+xml;charset=utf-8,%3Csvg"), "the link carries the same SVG");
  assert.equal(fig.querySelectorAll("details.statechart-state").length, 3);
  assert.equal(fig.querySelectorAll("details.statechart-transition").length, 3);
  assert.ok(fig.querySelector("details.statechart-state[open]"), "the current state opens");
  assert.ok([...fig.querySelectorAll("details.statechart-state dt")].some((dt) => dt.textContent === "owner"), "a state's own attribute is listed");
});

test("a definition held in data= is left as labelled source here; a body that does not build says why", () => {
  const viaData = render('=== data {#def format=json}\n{ "initial": "a", "states": { "a": {} }, "transitions": [] }\n===\n\n=== diagram {#g format=geml-statechart data=#def}\n===\n');
  const fig = viaData.querySelector("figure.statechart");
  assert.ok(fig && !fig.querySelector("svg"), "no picture without following data=");
  assert.ok(fig.querySelector("figcaption").textContent.includes("definition in data=#def"));
  const broken = render('=== diagram {#b format=geml-statechart}\n{ "initial": "x", "states": {}, "transitions": [] }\n===\n');
  const fb = broken.querySelector("figure.statechart");
  assert.ok(fb && !fb.querySelector("svg"));
  assert.ok(fb.querySelector("figcaption").textContent.includes("`initial` names `x`"));
});

console.log(`\n${passed} passed`);
