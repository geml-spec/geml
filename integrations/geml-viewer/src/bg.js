// Background service worker: inject the heavy mermaid chunk into a tab's
// isolated world when its content script asks for it. executeScript is used
// instead of a dynamic import() in the content script because import() there
// is subject to the page's CSP — which the viewer's primary hosts (e.g.
// raw.githubusercontent.com, `default-src 'none'`) would block — while
// executeScript is not. The chunk sets globalThis.__GEML_MERMAID__ in the same
// isolated world the content script runs in.
// A content script on a `file://` page runs in the opaque origin `null`, and
// Chrome refuses every cross-origin file read from there — so `=== embed
// {src=sibling.geml#id}` could never load its target from disk, which is the
// most ordinary way anyone tries the feature. The extension's own context has
// the file permission the user granted, so the read happens here.
//
// The confinement is re-derived HERE rather than trusted from the caller: the
// target must be a `file://` URL under the SAME DIRECTORY as the tab that asked,
// and must be a `.geml` document. That is the same rule content.js applies
// before asking, restated where it cannot be bypassed by whatever is running in
// the page.
function fileReadAllowed(target, tabUrl) {
  let u, base;
  try { u = new URL(target); base = new URL(tabUrl ?? ""); } catch { return false; }
  if (base.protocol !== "file:" || u.protocol !== "file:") return false;
  if (!/\.geml[^/]*$/i.test(u.pathname)) return false;
  return u.href.startsWith(base.href.slice(0, base.href.lastIndexOf("/") + 1));
}

// A snapshot on its way to a tab that can actually save it.
//
// The pages this extension renders are served with `Content-Security-Policy:
// … sandbox` (measured on raw.githubusercontent.com), and a bare `sandbox`
// withholds `allow-downloads` — so an `<a download>` there is inert no matter
// which world the script runs in, because a download is a document-level act and
// the document is sandboxed. An extension page is a different document with a
// different origin, so the save works there and no `downloads` permission is
// needed: opening the extension's own URL requires none.
const pendingExports = new Map();
let nextExport = 1;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "geml-export-snapshot") {
    const id = String(nextExport++);
    pendingExports.set(id, { md: String(msg.md ?? ""), name: String(msg.name ?? "snapshot.md"), untranslated: Array.isArray(msg.untranslated) ? msg.untranslated : [] });
    chrome.tabs.create({ url: chrome.runtime.getURL(`src/export.html?id=${id}`) });
    sendResponse({ ok: true });
    return false;
  }
  if (msg && msg.type === "geml-export-take") {
    // Handed over once: the page that asked owns it, and a service worker that
    // is about to be killed should not be the only copy of anything.
    const got = pendingExports.get(String(msg.id));
    pendingExports.delete(String(msg.id));
    sendResponse(got ? { ok: true, ...got } : { ok: false, error: "this snapshot has already been taken" });
    return false;
  }
  if (msg && msg.type === "geml-read-file") {
    if (!fileReadAllowed(msg.url, sender.tab?.url)) {
      sendResponse({ ok: false, error: "refused: not a sibling .geml file" });
      return false;
    }
    fetch(msg.url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(
        (text) => sendResponse({ ok: true, text }),
        (e) => sendResponse({ ok: false, error: String(e?.message ?? e) }),
      );
    return true; // async sendResponse — keep the channel open
  }
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
  // PARKED (see the block below): the offscreen handler for the WASM diagram
  // engines is intentionally disabled in the shipped build.
  // if (msg && msg.type === "geml-offscreen-ensure") {
  //   ensureOffscreenDocument().then(
  //     () => sendResponse({ ok: true }),
  //     (e) => sendResponse({ ok: false, error: String(e) }),
  //   );
  //   return true; // async sendResponse — keep the channel open
  // }
  // "geml-sandbox-render" is answered by the offscreen page itself — NOT here.
});

// PARKED — D2 / Graphviz WASM diagram engines. Disabled in the shipped build:
// it needs the "offscreen" permission and the *-sandbox.html pages, none of
// which this package declares or ships, so a strict store review would see a
// call to an undeclared API and a reference to files not in the package. The
// code is kept (commented) so it returns as one piece — uncomment this block,
// re-enable the geml-offscreen-ensure handler above, add "offscreen" to the
// manifest permissions, and ship the sandbox pages — when D2/Graphviz land.
//
// The WASM diagram engines need CSP grants no extension page may carry — D2
// (Go→WASM) spins up a blob: worker, Graphviz (@viz-js/viz, Emscripten)
// instantiates inlined WASM — only a sandboxed page's CSP can allow those. So
// the offscreen document hosts sandboxed iframes (<engine>-sandbox.html, one
// per engine, created lazily) that run the engines. Chrome allows a single
// offscreen document per extension: dedupe concurrent creates with a
// module-level promise, and treat "already exists" as success (e.g. after this
// worker was restarted while the document lived on).
//
// let offscreenCreating = null;
// function ensureOffscreenDocument() {
//   if (!offscreenCreating) {
//     offscreenCreating = chrome.offscreen
//       .createDocument({
//         url: "offscreen.html",
//         reasons: ["IFRAME_SCRIPTING"],
//         justification: "Render diagrams (WASM engines: D2, Graphviz) inside sandboxed iframes",
//       })
//       .catch((e) => {
//         if (/single offscreen/i.test(String(e))) return; // already exists — fine
//         offscreenCreating = null; // allow a retry on real failures
//         throw e;
//       });
//   }
//   return offscreenCreating;
// }
