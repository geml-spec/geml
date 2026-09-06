// Placeholder upgrades (src/upgrade.js): the DOM rewrites that run AFTER
// render — math (KaTeX), mermaid, and the geml-code-graph mounts. render.js is
// covered elsewhere; these paths were not, even though every one of them writes
// to the DOM from document-supplied text.
//
// The heavy libraries are INJECTED (that is why upgrade.js takes them as
// arguments), so each is a small stub here: the tests assert what upgrade.js
// does with what a library returns — including the failure paths, where the
// source text must stay visible instead of vanishing.
import { upgradeMath, upgradeMermaid, normalizeMermaid, upgradeCodeGraph, upgradeSandboxDiagrams } from "../src/upgrade.js";
import { parseHTML } from "linkedom";
import { strict as assert } from "node:assert";

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok", name); }

const dom = (body) => parseHTML(`<!doctype html><html><head></head><body>${body}</body></html>`).document;

// ---------------------------------------------------------------------------
// normalizeMermaid — pure text massaging (mermaid v11 is whitespace-picky)
// ---------------------------------------------------------------------------

await test("normalizeMermaid: strips CR, trailing spaces and collapses run-on edge-label gaps", () => {
  assert.equal(normalizeMermaid("graph LR\r\n  A --> B   \r\n"), "graph LR\n  A --> B");
  // `|label|   Node` — mermaid needs exactly one space after the label.
  assert.equal(normalizeMermaid("A -->|ok|    B"), "A -->|ok| B");
  assert.equal(normalizeMermaid("   \n\n  "), "", "whitespace-only source normalizes to empty");
});

// ---------------------------------------------------------------------------
// upgradeMath — KaTeX is injected; a throwing KaTeX must keep the source text
// ---------------------------------------------------------------------------

await test("upgradeMath: renders inline + display placeholders via the injected katex", () => {
  const d = dom('<span class="geml-math" data-tex="a^2">a^2</span><div class="geml-math-display" data-tex="b^2">b^2</div>');
  const seen = [];
  upgradeMath(d, { render: (tex, el, opts) => { seen.push({ tex, display: !!(opts && opts.displayMode) }); el.textContent = "KATEX:" + tex; } });
  assert.deepEqual(seen, [{ tex: "a^2", display: false }, { tex: "b^2", display: true }],
    "inline rendered non-display, block rendered with displayMode");
  assert.equal(d.querySelector(".geml-math").textContent, "KATEX:a^2");
});

await test("upgradeMath: a throwing katex leaves the source text as the fallback", () => {
  const d = dom('<span class="geml-math" data-tex="\\bad">\\bad</span>');
  upgradeMath(d, { render: () => { throw new Error("katex parse error"); } });
  assert.equal(d.querySelector(".geml-math").textContent, "\\bad", "source kept, no throw escaped");
});

// ---------------------------------------------------------------------------
// upgradeMermaid — the shipped diagram path
// ---------------------------------------------------------------------------

await test("upgradeMermaid: initializes with securityLevel strict and swaps in the returned svg", async () => {
  const d = dom('<div class="geml-mermaid">graph LR\n  A --> B   </div>');
  let cfg = null; const rendered = [];
  await upgradeMermaid(d, {
    initialize: (c) => { cfg = c; },
    render: async (id, src) => { rendered.push({ id, src }); return { svg: `<svg id="${id}"><g>ok</g></svg>` }; },
  });
  assert.equal(cfg.securityLevel, "strict", "mermaid is initialized in strict (DOMPurify) mode");
  assert.equal(cfg.startOnLoad, false, "no DOM auto-scan — we render programmatically");
  assert.equal(rendered.length, 1, "one render call for the one placeholder");
  assert.equal(rendered[0].src, "graph LR\n  A --> B", "source was normalized before rendering");
  assert.ok(d.querySelector(".geml-mermaid svg"), "the returned svg replaced the placeholder text");
});

await test("upgradeMermaid: a theme reaches initialize, and is absent when not asked for", async () => {
  // The theme MUST go into this initialize() call: mermaid recomputes its
  // palette from whatever theme the latest call names, so a caller that
  // initializes beforehand silently loses. Hosts inside a themed editor (the
  // VS Code preview) depend on this, and a plain web page must keep mermaid's
  // own default — hence both directions.
  const run = async (opts) => {
    const d = dom('<div class="geml-mermaid">graph LR\n A-->B</div>');
    let cfg = null;
    await upgradeMermaid(d, {
      initialize: (c) => { cfg = c; },
      render: async () => ({ svg: "<svg><g/></svg>" }),
    }, opts);
    return cfg;
  };

  const themed = await run({ theme: "dark" });
  assert.equal(themed.theme, "dark", "the requested theme is passed through");
  assert.equal(themed.securityLevel, "strict", "and does not displace the security setting");

  for (const opts of [undefined, {}, { theme: undefined }]) {
    const cfg = await run(opts);
    assert.ok(!("theme" in cfg), `no theme key for ${JSON.stringify(opts)} — mermaid keeps its default`);
  }
});

await test("upgradeMermaid: unique ids per placeholder; a failing render keeps that source visible", async () => {
  const d = dom('<div class="geml-mermaid">graph LR\n A-->B</div><div class="geml-mermaid">BOOM</div>');
  const ids = [];
  await upgradeMermaid(d, {
    initialize: () => {},
    render: async (id, src) => {
      ids.push(id);
      if (src === "BOOM") throw new Error("Syntax error in text");
      return { svg: "<svg><g/></svg>" };
    },
  });
  assert.equal(new Set(ids).size, 2, "each placeholder got a unique render id");
  const nodes = [...d.querySelectorAll(".geml-mermaid")];
  assert.ok(nodes[0].querySelector("svg"), "the good diagram rendered");
  assert.equal(nodes[1].textContent, "BOOM", "the failing diagram keeps its source text");
});

await test("upgradeMermaid: a mermaid whose initialize throws is treated as unavailable (sources kept)", async () => {
  const d = dom('<div class="geml-mermaid">graph LR\n A-->B</div>');
  await upgradeMermaid(d, { initialize: () => { throw new Error("no mermaid"); }, render: async () => { throw new Error("unreachable"); } });
  assert.equal(d.querySelector(".geml-mermaid").textContent, "graph LR\n A-->B", "source untouched");
});

await test("upgradeMermaid: no placeholders is a no-op (mermaid never touched)", async () => {
  const d = dom("<p>nothing here</p>");
  await upgradeMermaid(d, { initialize: () => { throw new Error("must not be called"); } });
  assert.equal(d.querySelector("p").textContent, "nothing here");
});

// ---------------------------------------------------------------------------
// upgradeSandboxDiagrams — PARKED engines, but the guard still ships
// ---------------------------------------------------------------------------

await test("upgradeSandboxDiagrams: inserts a returned svg but REJECTS a script-bearing one", async () => {
  const d = dom('<div class="geml-d2">a -> b</div><div class="geml-d2">evil</div>');
  await upgradeSandboxDiagrams(d, "d2", async (sources) => {
    assert.deepEqual(sources, ["a -> b", "evil"], "all sources batched into one call");
    return [{ svg: "<svg><g>fine</g></svg>" }, { svg: "<svg><script>alert(1)</script></svg>" }];
  }, (svg) => svg); // R5: a sanitizer is required; identity here — the <script check is the assertion
  const nodes = [...d.querySelectorAll(".geml-d2")];
  assert.ok(nodes[0].querySelector("svg"), "the clean svg was inserted");
  assert.ok(!nodes[1].querySelector("script"), "no <script> reached the DOM");
  assert.match(nodes[1].textContent, /unsafe svg rejected/, "the rejection is surfaced to the reader");
});

await test("upgradeSandboxDiagrams: a per-source error note is shown; a thrown batch keeps every source", async () => {
  const d1 = dom('<div class="geml-d2">a -> b</div>');
  await upgradeSandboxDiagrams(d1, "d2", async () => [{ error: "engine timeout" }]);
  assert.match(d1.querySelector(".geml-d2").textContent, /d2: engine timeout/, "per-source error reported");

  const d2 = dom('<div class="geml-d2">a -> b</div>');
  await upgradeSandboxDiagrams(d2, "d2", async () => { throw new Error("transport down"); });
  assert.equal(d2.querySelector(".geml-d2").textContent, "a -> b", "batch failure keeps the source text");
});

// ---------------------------------------------------------------------------
// upgradeCodeGraph — mount wiring, @self seeding, errors, and the _cgView loader
// ---------------------------------------------------------------------------

// A stand-in for the reference renderer's wave builder: records what it was
// asked for and replays scripted results.
function stubWaves(script) {
  const calls = [];
  const seeded = [];
  return {
    calls, seeded,
    waves: (fetchDoc, parse) => ({
      seed: (name, text) => seeded.push({ name, text }),
      build: async (src, view) => { calls.push({ src, view }); return script(src, view); },
    }),
  };
}

await test("upgradeCodeGraph: a resolved mount gets data-graph, cleared text, and the runtime runs", async () => {
  const d = dom('<figure class="code-graph"><div class="cg-mount" data-src="index.geml">loading code graph …</div></figure>');
  const s = stubWaves(() => ({ data: { start: "index.geml", nodes: {}, edges: [] } }));
  let ranOn = null;
  await upgradeCodeGraph(d, { waves: s.waves, parse: () => ({}), runtime: (r) => { ranOn = r; }, fetchDoc: async () => null });
  const mount = d.querySelector(".cg-mount");
  assert.equal(mount.textContent, "", "the loading text was cleared");
  assert.equal(JSON.parse(mount.getAttribute("data-graph")).start, "index.geml", "graph payload attached");
  assert.equal(ranOn, d, "the draw-time runtime was invoked on the root");
  assert.deepEqual(s.calls, [{ src: "index.geml", view: undefined }]);
});

await test("upgradeCodeGraph: @self seeds the self document and builds from its name", async () => {
  const d = dom('<div class="cg-mount" data-src="@self">loading …</div>');
  const s = stubWaves(() => ({ data: { start: "me.geml" } }));
  await upgradeCodeGraph(d, {
    waves: s.waves, parse: () => ({}), runtime: () => {}, fetchDoc: async () => null,
    selfName: "me.geml", selfSource: "=== meta\nmodule = m\n===\n",
  });
  assert.deepEqual(s.seeded, [{ name: "me.geml", text: "=== meta\nmodule = m\n===\n" }], "self source seeded into the cache");
  assert.equal(s.calls[0].src, "me.geml", "@self resolved to the document's own name");
});

await test("upgradeCodeGraph: @self with no self source, and a build error, both degrade to readable text", async () => {
  const d1 = dom('<div class="cg-mount" data-src="@self">loading …</div>');
  const s1 = stubWaves(() => ({ data: {} }));
  await upgradeCodeGraph(d1, { waves: s1.waves, parse: () => ({}), runtime: () => {}, fetchDoc: async () => null });
  assert.match(d1.querySelector(".cg-mount").textContent, /no self source/);
  assert.equal(s1.calls.length, 0, "nothing was built");

  const d2 = dom('<div class="cg-mount" data-src="missing.geml">loading …</div>');
  const s2 = stubWaves(() => ({ error: "cannot load `missing.geml`" }));
  await upgradeCodeGraph(d2, { waves: s2.waves, parse: () => ({}), runtime: () => {}, fetchDoc: async () => null });
  assert.match(d2.querySelector(".cg-mount").textContent, /geml-code-graph: cannot load `missing\.geml`/);
  assert.equal(d2.querySelector(".cg-mount").getAttribute("data-graph"), null, "no payload on a failed build");
});

await test("upgradeCodeGraph: a truncated slice inserts the narrow-your-entry-set note after the mount", async () => {
  const d = dom('<figure><div class="cg-mount" data-src="index.geml">loading …</div></figure>');
  const s = stubWaves(() => ({ data: { start: "index.geml" }, truncated: true }));
  await upgradeCodeGraph(d, { waves: s.waves, parse: () => ({}), runtime: () => {}, fetchDoc: async () => null });
  const note = d.querySelector(".cg-note");
  assert.ok(note, "a note element was inserted");
  assert.match(note.textContent, /slice truncated/);
  assert.equal(note.previousSibling.className, "cg-mount", "the note sits directly after its mount");
});

await test("upgradeCodeGraph: _cgView rebuilds for {doc}, {node} and the default view, and maps errors to null", async () => {
  const d = dom('<div class="cg-mount" data-src="pkg/index.geml">loading …</div>');
  const s = stubWaves((src) => (src === "bad.geml" ? { error: "nope" } : { data: { start: src } }));
  await upgradeCodeGraph(d, { waves: s.waves, parse: () => ({}), runtime: () => {}, fetchDoc: async () => null });
  const view = d.querySelector(".cg-mount")._cgView;
  assert.equal(typeof view, "function", "the live loader was attached");

  // {doc}: another codemap document's DEFAULT view — no directed view passed on.
  assert.deepEqual(await view({ doc: "other.geml" }), { start: "other.geml" });
  assert.deepEqual(s.calls.at(-1), { src: "other.geml", view: undefined }, "{doc} drops the directed view");

  // {node}: built from the node's OWN document (everything before the last '#').
  const nodeView = { dir: "up", node: "pkg/mod.geml#fn" };
  assert.deepEqual(await view(nodeView), { start: "pkg/mod.geml" });
  assert.deepEqual(s.calls.at(-1), { src: "pkg/mod.geml", view: nodeView }, "{node} keeps the direction");

  // No argument: rebuild the mount's own source.
  assert.deepEqual(await view(undefined), { start: "pkg/index.geml" });

  // A failed rebuild is null (the runtime keeps the current drawing).
  assert.equal(await view({ doc: "bad.geml" }), null, "an error maps to null, not a throw");
});

await test("upgradeCodeGraph: no mounts means the wave builder is never constructed", async () => {
  const d = dom("<p>no graph here</p>");
  await upgradeCodeGraph(d, {
    waves: () => { throw new Error("must not be called"); },
    parse: () => ({}), runtime: () => { throw new Error("must not be called"); }, fetchDoc: async () => null,
  });
  assert.equal(d.querySelector("p").textContent, "no graph here");
});

console.log(`\n${passed} test(s) passed.`);
