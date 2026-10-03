// D2 tests, two layers:
//   1. upgradeD2 against a FAKE renderAll (no engine) — the DOM swap, the
//      degrade-on-error path, and the <script guard, all in linkedom.
//   2. an engine smoke test with the real @terrastruct/d2 (its Node build,
//      worker_threads-backed) — compile + render `x -> y` must produce an SVG.
import { upgradeD2 } from "../src/upgrade.js";
import { parseHTML } from "linkedom";
import { strict as assert } from "node:assert";

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok", name); }

function docWith(html) {
  const { document } = parseHTML(`<!doctype html><html><head></head><body>${html}</body></html>`);
  return document;
}

await test("upgradeD2: one batched call; svg results replace the source", async () => {
  const document = docWith(
    '<div class="geml-d2">x -&gt; y</div><div class="geml-d2">a -&gt; b</div>',
  );
  let calls = 0;
  let seen;
  const renderAll = async (sources) => {
    calls++;
    seen = sources;
    return sources.map((s, i) => ({ svg: `<svg data-i="${i}"><g></g></svg>` }));
  };
  await upgradeD2(document, renderAll, (svg) => svg);
  assert.equal(calls, 1, "all placeholders rendered in ONE batched call");
  assert.deepEqual(seen, ["x -> y", "a -> b"], "sources are the placeholders' text");
  const nodes = document.querySelectorAll(".geml-d2");
  assert.ok(nodes[0].querySelector('svg[data-i="0"]'), "first svg inserted");
  assert.ok(nodes[1].querySelector('svg[data-i="1"]'), "second svg inserted");
  assert.doesNotMatch(nodes[0].textContent, /x -> y/, "source text replaced");
});

await test("upgradeD2: error result keeps the source and shows the error", async () => {
  const document = docWith('<div class="geml-d2">x -&gt; y</div>');
  await upgradeD2(document, async (sources) => sources.map(() => ({ error: "boom" })), (svg) => svg);
  const node = document.querySelector(".geml-d2");
  assert.match(node.textContent, /x -> y/, "source text kept");
  const err = node.querySelector(".geml-d2-error");
  assert.ok(err, "error element appended");
  assert.match(err.textContent, /boom/);
  assert.equal(node.querySelector("svg"), null, "no svg inserted");
});

await test("upgradeD2: an svg carrying <script is rejected, source kept", async () => {
  const document = docWith('<div class="geml-d2">x -&gt; y</div>');
  await upgradeD2(document, async () => [{ svg: "<svg><script>alert(1)</script></svg>" }], (svg) => svg);
  const node = document.querySelector(".geml-d2");
  assert.match(node.textContent, /x -> y/, "source text kept");
  assert.equal(node.querySelector("script"), null, "script never inserted");
  const err = node.querySelector(".geml-d2-error");
  assert.ok(err && /unsafe svg rejected/.test(err.textContent));
});

await test("upgradeD2: renderAll throwing leaves every source untouched", async () => {
  const document = docWith('<div class="geml-d2">x -&gt; y</div>');
  await upgradeD2(document, async () => { throw new Error("transport down"); }, (svg) => svg);
  const node = document.querySelector(".geml-d2");
  assert.match(node.textContent, /x -> y/, "source text kept");
  assert.equal(node.querySelector("svg"), null);
});

await test("engine smoke: real @terrastruct/d2 renders `x -> y` to SVG", async () => {
  const { D2 } = await import("@terrastruct/d2");
  const d2 = new D2();
  try {
    const c = await d2.compile("x -> y");
    const svg = await d2.render(c.diagram, c.renderOptions);
    assert.equal(typeof svg, "string");
    assert.match(svg, /<svg/, "output contains <svg");
  } finally {
    // The Node build runs on a worker_threads Worker that would otherwise keep
    // the process alive; the class has no shutdown API, so terminate directly.
    await d2.worker?.terminate?.();
  }
});


// R5: the SVG comes back from a WASM engine over two message hops, and
// `/<script/i` was the only thing between it and innerHTML — `<a
// xlink:href="javascript:…">`, `on*=` attributes and `<foreignObject>` all pass
// that test. A sanitizer is REQUIRED now: with none, nothing is inserted and
// the source stays, which is the failure mode a broken engine already has.
await test("upgradeD2: with no sanitizer nothing is inserted, and the note says why", async () => {
  const document = docWith('<div class="geml-d2">x -&gt; y</div>');
  await upgradeD2(document, async () => [{ svg: '<svg><a xlink:href="javascript:alert(1)">x</a></svg>' }]);
  const node = document.querySelector(".geml-d2");
  assert.match(node.textContent, /x -> y/, "source text kept");
  assert.equal(node.querySelector("svg"), null, "no svg inserted without a sanitizer");
  assert.ok(/no sanitizer/.test(node.querySelector(".geml-d2-error")?.textContent ?? ""));
});

await test("upgradeD2: the sanitizer's OUTPUT is what gets inserted, and an empty or scripted output is refused", async () => {
  const document = docWith('<div class="geml-d2">x -&gt; y</div><div class="geml-d2">a -&gt; b</div>');
  const strip = (svg) => svg.replace(/<a\b[^>]*>|<\/a>/g, "");
  await upgradeD2(document, async (sources) => sources.map((_, i) => ({ svg: i === 0 ? '<svg><a xlink:href="javascript:alert(1)">t</a><g></g></svg>' : "<svg></svg>" })), (svg) => (svg === "<svg></svg>" ? "" : strip(svg)));
  const nodes = document.querySelectorAll(".geml-d2");
  assert.ok(nodes[0].querySelector("svg g"), "the sanitized svg is inserted");
  assert.equal(nodes[0].querySelector("a"), null, "…without the part the sanitizer removed");
  assert.equal(nodes[1].querySelector("svg"), null, "a sanitizer returning nothing means nothing is inserted");
});

console.log(`\n${passed} test(s) passed.`);
