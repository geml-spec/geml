// The Graphviz engine (@viz-js/viz, an Emscripten→WASM build with the .wasm
// inlined in the bundle — no worker, no fetch), bundled to
// dist/graphviz.chunk.js and run ONLY inside the sandboxed page
// (graphviz-sandbox.html): instantiating the inlined WASM needs
// 'wasm-unsafe-eval', which only the sandbox CSP grants (see manifest
// content_security_policy.sandbox). Protocol: the embedding offscreen document
// posts {id, sources:[string]}, we answer {id, results:[{svg}|{error}]} —
// per-source errors so one bad diagram never sinks the batch.
import { instance } from "@viz-js/viz";

const vizPromise = instance();
vizPromise.catch(() => {}); // handled per-message below; avoid an unhandled rejection

window.addEventListener("message", async (ev) => {
  const { id, sources } = ev.data || {};
  if (id === undefined || !Array.isArray(sources)) return;
  let viz = null;
  let initError = null;
  try {
    viz = await vizPromise;
  } catch (e) {
    initError = String((e && e.message) || e);
  }
  const results = [];
  for (const src of sources) {
    if (!viz) {
      results.push({ error: initError });
      continue;
    }
    try {
      // renderString throws on failure (unlike render(), which reports a
      // status object) — exactly the per-source semantics we want.
      results.push({ svg: viz.renderString(String(src), { format: "svg" }) });
    } catch (e) {
      results.push({ error: String((e && e.message) || e) });
    }
  }
  ev.source.postMessage({ id, results }, "*");
});
