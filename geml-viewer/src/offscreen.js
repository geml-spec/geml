// Offscreen-document relay (plain JS, not bundled). Content scripts can't talk
// to a sandboxed iframe directly, so this page bridges the two transports:
// chrome.runtime messages on one side, window.postMessage to a per-engine
// sandboxed iframe on the other. Iframes are created LAZILY — the first
// {type:"geml-sandbox-render", engine} request for an engine creates a hidden
// <engine>-sandbox.html iframe; posts made before that iframe finishes loading
// are queued until its load event. Requests are matched to replies by an
// incrementing id shared across all engines.
const ENGINES = ["d2", "graphviz"]; // each maps to a manifest sandbox page

const frames = new Map(); // engine -> { iframe, loaded, queued: [postFn] }

function ensureFrame(engine) {
  let f = frames.get(engine);
  if (f) return f;
  const iframe = document.createElement("iframe");
  iframe.hidden = true;
  iframe.src = engine + "-sandbox.html";
  f = { iframe, loaded: false, queued: [] };
  iframe.addEventListener("load", () => {
    f.loaded = true;
    for (const post of f.queued) post();
    f.queued.length = 0;
  });
  (document.body || document.documentElement).appendChild(iframe);
  frames.set(engine, f);
  return f;
}

let nextId = 1;
const pending = new Map(); // id -> sendResponse

window.addEventListener("message", (ev) => {
  // Only accept replies from one of our sandbox iframes.
  let ours = false;
  for (const f of frames.values()) {
    if (ev.source === f.iframe.contentWindow) { ours = true; break; }
  }
  if (!ours) return;
  const { id, results } = ev.data || {};
  const respond = pending.get(id);
  if (!respond) return;
  pending.delete(id);
  respond({ results });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "geml-sandbox-render") return;
  if (!ENGINES.includes(msg.engine)) {
    sendResponse({ results: null, error: `unknown sandbox engine: ${String(msg.engine)}` });
    return; // answered synchronously
  }
  const f = ensureFrame(msg.engine);
  const id = nextId++;
  pending.set(id, sendResponse);
  const post = () => f.iframe.contentWindow.postMessage({ id, sources: msg.sources }, "*");
  if (f.loaded) post();
  else f.queued.push(post);
  return true; // async sendResponse — keep the channel open
});
