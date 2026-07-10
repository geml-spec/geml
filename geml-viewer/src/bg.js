// Background service worker: inject the heavy mermaid chunk into a tab's
// isolated world when its content script asks for it. executeScript is used
// instead of a dynamic import() in the content script because import() there
// is subject to the page's CSP — which the viewer's primary hosts (e.g.
// raw.githubusercontent.com, `default-src 'none'`) would block — while
// executeScript is not. The chunk sets globalThis.__GEML_MERMAID__ in the same
// isolated world the content script runs in.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "geml-load-mermaid" || !sender.tab?.id) return;
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
});
