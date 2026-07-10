// The D2 engine, bundled to dist/d2.chunk.js and run ONLY inside the sandboxed
// page (d2-sandbox.html). D2 is a Go→WASM build that spawns a
// `new Worker(URL.createObjectURL(blob))` — a blob: worker no extension-page
// CSP may allow; a sandboxed page's CSP may (see manifest
// content_security_policy.sandbox). Protocol: the embedding offscreen document
// posts {id, sources:[string]}, we answer {id, results:[{svg}|{error}]} —
// per-source errors so one bad diagram never sinks the batch.
import { D2 } from "@terrastruct/d2";

const d2 = new D2();

window.addEventListener("message", async (ev) => {
  const { id, sources } = ev.data || {};
  if (id === undefined || !Array.isArray(sources)) return;
  const results = [];
  for (const src of sources) {
    try {
      const c = await d2.compile(String(src));
      const svg = await d2.render(c.diagram, c.renderOptions);
      results.push({ svg });
    } catch (e) {
      results.push({ error: String((e && e.message) || e) });
    }
  }
  ev.source.postMessage({ id, results }, "*");
});
