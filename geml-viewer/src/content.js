// Content script: detect a .geml document, parse it with the reference parser,
// render it to DOM, and upgrade math (KaTeX) and mermaid diagrams. Runs once at
// document_idle on URLs narrowed by include_globs in the manifest.

import { parse, codeGraphWaves, codeGraphRuntime } from "./parse-entry.js";
import { renderDocument, viewerDiagnostics } from "./render.js";
import { hasSrcTable, inlineSrcTables, looksTabular } from "./inline-src.js";
import { upgradeMath, upgradeMermaid, upgradeD2, upgradeGraphviz, upgradeCodeGraph } from "./upgrade.js";
import css from "./geml.css";
import katex from "katex";
import katexCss from "katex/dist/katex.css";

main();

async function main() {
  // include_globs matches any URL containing ".geml"; only act when the path
  // really ends in .geml/.gemlhistory (not e.g. an HTML page with ?x=a.geml)
  // or when the page is being served as plain text.
  const isGemlPath = /\.geml(history)?$/i.test(location.pathname);
  const isPlain = document.contentType === "text/plain";
  if (!isGemlPath && !isPlain) return;

  let raw = await readSource();
  if (raw == null || raw.trim() === "") return;

  // §6: if any table loads from src=, fetch and inline it before parsing, so
  // data / compute / summary / chart / column-checking all run on inline data.
  // A src that fails to load is left external; the renderer shows a placeholder.
  if (hasSrcTable(raw)) {
    try {
      raw = await inlineSrcTables(
        raw,
        (src) => new URL(src, location.href).href,
        async (url) => {
          try {
            const r = await fetch(url);
            if (!r.ok) return null;
            const ct = r.headers.get("content-type") || "";
            if (/\b(html|json|xml)\b/i.test(ct)) return null; // obviously not CSV
            const text = await r.text();
            return looksTabular(text) ? text : null; // guard against error pages
          } catch {
            return null;
          }
        },
      );
    } catch (e) {
      console.error("[geml-viewer] src table inlining failed:", e);
    }
  }

  let model;
  try {
    model = parse(raw);
  } catch (e) {
    paintError(raw, e);
    return;
  }

  // Drop "cross-document not checked" warnings — a browser viewer limitation,
  // not a document problem. Real errors/warnings still show.
  model.diagnostics = viewerDiagnostics(model.diagnostics);

  injectStyle();
  document.body.className = "geml-body";
  document.body.replaceChildren(renderDocument(model, document));
  setTitleFromMeta(raw);

  upgradeMath(document, katex);
  // Mermaid is heavy (it dominated the old single bundle), so it lives in its
  // own chunk, loaded only when the document actually has a diagram — pages
  // without one never pay its parse/execute cost.
  if (document.querySelector(".geml-mermaid")) {
    const mermaid = await loadMermaid();
    if (mermaid) await upgradeMermaid(document, mermaid);
  }
  // The WASM engines (D2: Go→WASM + blob: worker; Graphviz: Emscripten WASM)
  // need CSP grants no extension page's CSP allows — each runs in its own
  // sandboxed iframe inside an offscreen document, created only when a page
  // actually has such a diagram.
  if (document.querySelector(".geml-d2")) {
    await upgradeD2(document, (sources) => renderViaSandbox("d2", sources));
  }
  if (document.querySelector(".geml-graphviz")) {
    await upgradeGraphviz(document, (sources) => renderViaSandbox("graphviz", sources));
  }
  // geml-code-graph mounts: sibling codemap documents are fetched relative to
  // this page URL. On hosts whose page CSP restricts connect-src (e.g.
  // raw.githubusercontent.com), sibling fetches may be blocked — the mount
  // then degrades to a readable error instead of a graph.
  await upgradeCodeGraph(document, {
    waves: codeGraphWaves,
    parse,
    runtime: codeGraphRuntime,
    selfName: decodeURIComponent(location.pathname.split("/").pop() || ""),
    selfSource: raw,
    fetchDoc: async (rel) => {
      try {
        const res = await fetch(new URL(rel, location.href).toString(), { credentials: "omit" });
        return res.ok ? await res.text() : null;
      } catch { return null; }
    },
  });
}

// Ask the background worker to inject dist/mermaid.chunk.js into this tab's
// isolated world (it sets globalThis.__GEML_MERMAID__), then hand it back.
// executeScript rather than import(): a content script's dynamic import() is
// subject to the page CSP, which e.g. raw.githubusercontent.com sets to
// `default-src 'none'`. A load failure degrades to the diagram's source text.
async function loadMermaid() {
  if (globalThis.__GEML_MERMAID__) return globalThis.__GEML_MERMAID__;
  try {
    const r = await chrome.runtime.sendMessage({ type: "geml-load-mermaid" });
    if (!r || !r.ok) throw new Error(r && r.error ? r.error : "no response from background worker");
  } catch (e) {
    console.error("[geml-viewer] mermaid chunk load failed:", e);
    return null;
  }
  return globalThis.__GEML_MERMAID__ ?? null;
}

// Render diagram sources via the extension's offscreen document. Two hops:
// first ask the background worker to create the offscreen document (it hosts
// sandboxed iframes running the WASM engines — the only MV3 contexts whose CSP
// may allow what they need: D2's blob: worker, Graphviz's WASM instantiation),
// then send the batched engine-keyed render request, which the OFFSCREEN page
// answers (bg deliberately ignores it). Any failure degrades to per-source
// errors so the upgrade keeps the source text visible.
async function renderViaSandbox(engine, sources) {
  try {
    const up = await chrome.runtime.sendMessage({ type: "geml-offscreen-ensure" });
    if (!up || !up.ok) throw new Error(up && up.error ? up.error : "no response from background worker");
    const r = await chrome.runtime.sendMessage({ type: "geml-sandbox-render", engine, sources });
    if (!r || !Array.isArray(r.results)) {
      throw new Error(r && r.error ? r.error : "no response from offscreen document");
    }
    return r.results;
  } catch (e) {
    console.error(`[geml-viewer] ${engine} render via extension failed:`, e);
    return sources.map(() => ({ error: String(e && e.message ? e.message : e) }));
  }
}

// Prefer the original bytes (fetch); fall back to the rendered plain-text DOM.
async function readSource() {
  // file:// is a unique origin: fetch() is blocked by CORS, so read the DOM
  // directly (the page is shown as plain text in a <pre>). Only fetch over http(s).
  if (location.protocol !== "file:") {
    try {
      const r = await fetch(location.href);
      if (r.ok) return await r.text();
    } catch {
      /* fall through to the DOM */
    }
  }
  const pre = document.querySelector("pre");
  if (pre) return pre.textContent;
  return document.body ? document.body.innerText : null;
}

function injectStyle() {
  const style = document.createElement("style");
  style.textContent = css + "\n" + rewriteKatexFonts(katexCss);
  document.head.appendChild(style);
}

// KaTeX's CSS references url(fonts/KaTeX_*.woff2); point those at the copies
// exposed via web_accessible_resources.
function rewriteKatexFonts(cssText) {
  const base = chrome.runtime.getURL("dist/fonts/");
  return cssText.replace(/url\(([^)]*?)fonts\/(KaTeX[^)]+?)\)/g, (_m, _p, f) => `url(${base}${f})`);
}

function setTitleFromMeta(raw) {
  const m = /^\s*title\s*=\s*"([^"]+)"/m.exec(raw);
  if (m) document.title = m[1];
}

function paintError(raw, e) {
  injectStyle();
  document.body.className = "geml-body";
  const doc = document.createElement("div");
  doc.className = "geml-doc";
  const banner = document.createElement("div");
  banner.className = "geml-diag geml-diag-error";
  banner.textContent = `GEML could not be parsed: ${e && e.message ? e.message : e}`;
  const pre = document.createElement("pre");
  pre.textContent = raw;
  doc.append(banner, pre);
  document.body.replaceChildren(doc);
}
