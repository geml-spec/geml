// Background service worker: inject the heavy mermaid chunk into a tab's
// isolated world when its content script asks for it. executeScript is used
// instead of a dynamic import() in the content script because import() there
// is subject to the page's CSP — which the viewer's primary hosts (e.g.
// raw.githubusercontent.com, `default-src 'none'`) would block — while
// executeScript is not. The chunk sets globalThis.__GEML_MERMAID__ in the same
// isolated world the content script runs in.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "geml-load-mermaid" && sender.tab?.id) {
    chrome.scripting
      .executeScript({
        target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] },
        files: ["dist/mermaid.chunk.js"],
      })
      .then(
        () => sendResponse({ ok: true }),
        (e) => sendResponse({ ok: false, error: String(e) }),
      );
    return true; // async sendResponse — keep the channel open
  }
  if (msg && msg.type === "geml-d2-ensure") {
    ensureOffscreenDocument().then(
      () => sendResponse({ ok: true }),
      (e) => sendResponse({ ok: false, error: String(e) }),
    );
    return true; // async sendResponse — keep the channel open
  }
  // "geml-d2-render" is answered by the offscreen page itself — NOT here.
  // Returning nothing leaves the reply channel to it.
});

// D2's engine (Go→WASM) spins up a blob: worker, which no extension page CSP
// may allow — only a sandboxed page's CSP can. So the offscreen document hosts
// a sandboxed iframe (d2-sandbox.html) that runs the engine. Chrome allows a
// single offscreen document per extension: dedupe concurrent creates with a
// module-level promise, and treat "already exists" as success (e.g. after this
// worker was restarted while the document lived on).
let offscreenCreating = null;
function ensureOffscreenDocument() {
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: ["IFRAME_SCRIPTING"],
        justification: "Render D2 diagrams (WASM + blob worker) inside a sandboxed iframe",
      })
      .catch((e) => {
        if (/single offscreen/i.test(String(e))) return; // already exists — fine
        offscreenCreating = null; // allow a retry on real failures
        throw e;
      });
  }
  return offscreenCreating;
}
