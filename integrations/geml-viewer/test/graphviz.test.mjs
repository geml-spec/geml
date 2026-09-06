// Graphviz tests, two layers (mirroring d2.test.mjs — both engines share
// upgradeSandboxDiagrams, so these exercise the graphviz wrapper's engine
// keying: the .geml-graphviz placeholder class and .geml-graphviz-error note):
//   1. upgradeGraphviz against a FAKE renderAll (no engine) — the DOM swap,
//      the degrade-on-error path, and the <script guard, all in linkedom.
//   2. an engine smoke test with the real @viz-js/viz (Emscripten WASM,
//      inlined binary, no worker) — `digraph { a -> b }` must produce an SVG.
import { upgradeGraphviz } from "../src/upgrade.js";
import { parseHTML } from "linkedom";
import { strict as assert } from "node:assert";

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok", name); }

function docWith(html) {
  const { document } = parseHTML(`<!doctype html><html><head></head><body>${html}</body></html>`);
  return document;
}

await test("upgradeGraphviz: one batched call; svg results replace the source", async () => {
  const document = docWith(
    '<div class="geml-graphviz">digraph { a -&gt; b }</div><div class="geml-graphviz">digraph { c -&gt; d }</div>',
  );
  let calls = 0;
  let seen;
  const renderAll = async (sources) => {
    calls++;
    seen = sources;
    return sources.map((s, i) => ({ svg: `<svg data-i="${i}"><g></g></svg>` }));
  };
  await upgradeGraphviz(document, renderAll, (svg) => svg);
  assert.equal(calls, 1, "all placeholders rendered in ONE batched call");
  assert.deepEqual(seen, ["digraph { a -> b }", "digraph { c -> d }"], "sources are the placeholders' text");
  const nodes = document.querySelectorAll(".geml-graphviz");
  assert.ok(nodes[0].querySelector('svg[data-i="0"]'), "first svg inserted");
  assert.ok(nodes[1].querySelector('svg[data-i="1"]'), "second svg inserted");
  assert.doesNotMatch(nodes[0].textContent, /a -> b/, "source text replaced");
});

await test("upgradeGraphviz: error result keeps the source and shows the error", async () => {
  const document = docWith('<div class="geml-graphviz">digraph { a -&gt; b }</div>');
  await upgradeGraphviz(document, async (sources) => sources.map(() => ({ error: "boom" })), (svg) => svg);
  const node = document.querySelector(".geml-graphviz");
  assert.match(node.textContent, /a -> b/, "source text kept");
  const err = node.querySelector(".geml-graphviz-error");
  assert.ok(err, "engine-keyed error element appended");
  assert.match(err.textContent, /graphviz: boom/);
  assert.equal(node.querySelector("svg"), null, "no svg inserted");
});

await test("upgradeGraphviz: an svg carrying <script is rejected, source kept", async () => {
  const document = docWith('<div class="geml-graphviz">digraph { a -&gt; b }</div>');
  await upgradeGraphviz(document, async () => [{ svg: "<svg><script>alert(1)</script></svg>" }], (svg) => svg);
  const node = document.querySelector(".geml-graphviz");
  assert.match(node.textContent, /a -> b/, "source text kept");
  assert.equal(node.querySelector("script"), null, "script never inserted");
  const err = node.querySelector(".geml-graphviz-error");
  assert.ok(err && /unsafe svg rejected/.test(err.textContent));
});

await test("upgradeGraphviz: renderAll throwing leaves every source untouched", async () => {
  const document = docWith('<div class="geml-graphviz">digraph { a -&gt; b }</div>');
  await upgradeGraphviz(document, async () => { throw new Error("transport down"); }, (svg) => svg);
  const node = document.querySelector(".geml-graphviz");
  assert.match(node.textContent, /a -> b/, "source text kept");
  assert.equal(node.querySelector("svg"), null);
});

await test("engine smoke: real @viz-js/viz renders `digraph { a -> b }` to SVG", async () => {
  const { instance } = await import("@viz-js/viz");
  const viz = await instance();
  const svg = viz.renderString("digraph { a -> b }", { format: "svg" });
  assert.equal(typeof svg, "string");
  assert.match(svg, /<svg/, "output contains <svg");
  // renderString throws on invalid DOT — the sandbox's per-source error path
  assert.throws(() => viz.renderString("digraph {", { format: "svg" }));
});


// R5: the SVG comes back from a WASM engine over two message hops, and
// `/<script/i` was the only thing between it and innerHTML — `<a
// xlink:href="javascript:…">`, `on*=` attributes and `<foreignObject>` all pass
// that test. A sanitizer is REQUIRED now: with none, nothing is inserted and
// the source stays, which is the failure mode a broken engine already has.
await test("upgradeGraphviz: with no sanitizer nothing is inserted, and the note says why", async () => {
  const document = docWith('<div class="geml-graphviz">x -&gt; y</div>');
  await upgradeGraphviz(document, async () => [{ svg: '<svg><a xlink:href="javascript:alert(1)">x</a></svg>' }]);
  const node = document.querySelector(".geml-graphviz");
  assert.match(node.textContent, /x -> y/, "source text kept");
  assert.equal(node.querySelector("svg"), null, "no svg inserted without a sanitizer");
  assert.ok(/no sanitizer/.test(node.querySelector(".geml-graphviz-error")?.textContent ?? ""));
});

await test("upgradeGraphviz: the sanitizer's OUTPUT is what gets inserted, and an empty or scripted output is refused", async () => {
  const document = docWith('<div class="geml-graphviz">x -&gt; y</div><div class="geml-graphviz">a -&gt; b</div>');
  const strip = (svg) => svg.replace(/<a\b[^>]*>|<\/a>/g, "");
  await upgradeGraphviz(document, async (sources) => sources.map((_, i) => ({ svg: i === 0 ? '<svg><a xlink:href="javascript:alert(1)">t</a><g></g></svg>' : "<svg></svg>" })), (svg) => (svg === "<svg></svg>" ? "" : strip(svg)));
  const nodes = document.querySelectorAll(".geml-graphviz");
  assert.ok(nodes[0].querySelector("svg g"), "the sanitized svg is inserted");
  assert.equal(nodes[0].querySelector("a"), null, "…without the part the sanitizer removed");
  assert.equal(nodes[1].querySelector("svg"), null, "a sanitizer returning nothing means nothing is inserted");
});

console.log(`\n${passed} test(s) passed.`);
