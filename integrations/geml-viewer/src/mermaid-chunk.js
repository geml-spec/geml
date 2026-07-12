// The lazy mermaid chunk. Mermaid is by far the heaviest dependency (most of
// the old single bundle), so it ships as its own file and is injected into the
// content script's isolated world by the background worker
// (chrome.scripting.executeScript) ONLY when the page actually contains a
// mermaid diagram. Injection — not a dynamic import() — on purpose: a content
// script's import() is subject to the PAGE's CSP, and the viewer's primary
// hosts (e.g. raw.githubusercontent.com) serve `default-src 'none'`;
// executeScript is not subject to page CSP.
import mermaid from "mermaid";

globalThis.__GEML_MERMAID__ = mermaid;
