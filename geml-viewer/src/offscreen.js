// Offscreen-document relay (plain JS, not bundled). Content scripts can't talk
// to the sandboxed iframe directly, so this page bridges the two transports:
// chrome.runtime messages on one side, window.postMessage to the iframe on the
// other. Requests are matched to replies by an incrementing id; posts made
// before the iframe finishes loading are queued until its load event.
const iframe = document.getElementById("sb");

let iframeLoaded = false;
const queuedPosts = [];
iframe.addEventListener("load", () => {
  iframeLoaded = true;
  for (const post of queuedPosts) post();
  queuedPosts.length = 0;
});

let nextId = 1;
const pending = new Map(); // id -> sendResponse

window.addEventListener("message", (ev) => {
  if (ev.source !== iframe.contentWindow) return; // only our sandbox replies
  const { id, results } = ev.data || {};
  const respond = pending.get(id);
  if (!respond) return;
  pending.delete(id);
  respond({ results });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "geml-d2-render") return;
  const id = nextId++;
  pending.set(id, sendResponse);
  const post = () => iframe.contentWindow.postMessage({ id, sources: msg.sources }, "*");
  if (iframeLoaded) post();
  else queuedPosts.push(post);
  return true; // async sendResponse — keep the channel open
});
