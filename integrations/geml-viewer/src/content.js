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
  // include_globs matches any URL merely CONTAINING ".geml"; only act when the
  // path itself really ends in .geml/.gemlhistory. Content-type alone is NOT
  // enough: a text/plain response whose URL just contains ".geml" (e.g.
  // notes.geml.txt, or ?x=a.geml) could otherwise hijack any plain-text page.
  // A genuine .geml served as text/plain still renders — its path ends in .geml.
  const isGemlPath = /\.geml(history)?$/i.test(location.pathname);
  if (!isGemlPath) return;

  // The document must BE the raw .geml text — not an HTML page that merely has
  // .geml in its URL. GitHub's github.com/.../blob/....geml file *viewer* is a
  // full HTML document; without this guard readSource() would fetch that page's
  // HTML and parse GitHub's markup as GEML (garbage diagnostics). Raw hosts
  // (raw.githubusercontent.com) and file:// serve .geml as text/plain; a blob
  // page is text/html — skip it. file:// is always allowed (Chrome may label a
  // local .geml however it likes, and there readSource reads the <pre>).
  if (location.protocol !== "file:" && document.contentType !== "text/plain") return;

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
            // M1: only load same-origin resources (and, on file://, only within
            // the document's own directory) and never with credentials, so a
            // crafted src= cannot exfiltrate cookies, reach a cross-origin host,
            // or read arbitrary local files. The code-graph fetchDoc below shares
            // this same isSameOriginSrc confinement (R2-3).
            if (!isSameOriginSrc(url)) return null;
            const r = await fetch(url, { credentials: "omit" });
            if (!r.ok) return null;
            if (r.url && !isSameOriginSrc(r.url)) return null; // redirect went off-origin
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
  //
  // PARKED: only mermaid is popular enough to ship for now; render.js no
  // longer emits these placeholders. Re-enable checklist lives in build.mjs
  // ("PARKED ENGINES").
  // if (document.querySelector(".geml-d2")) {
  //   await upgradeD2(document, (sources) => renderViaSandbox("d2", sources));
  // }
  // if (document.querySelector(".geml-graphviz")) {
  //   await upgradeGraphviz(document, (sources) => renderViaSandbox("graphviz", sources));
  // }
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
        // R2-3: confine sibling-doc fetches exactly like the src= table fetch
        // above — same-origin over http(s), same-directory on file:// — so a
        // document-supplied `rel` cannot read arbitrary local files
        // (file:///etc/passwd), escape the directory (../), or beacon / SSRF a
        // cross-origin host. Refused fetches return null, which the code-graph
        // mount already degrades to a readable "sibling fetch blocked" error.
        const url = new URL(rel, location.href).toString();
        if (!isSameOriginSrc(url)) return null;
        const res = await fetch(url, { credentials: "omit" });
        if (!res.ok) return null;
        if (res.url && !isSameOriginSrc(res.url)) return null; // redirect went off-origin
        return await res.text();
      } catch { return null; }
    },
  });
}

// Same-origin (and, for file:// documents, same-directory) guard for `src=`
// table fetches (M1). http(s): the resolved URL must share the document's
// origin — root-relative and ../ paths that stay on-site work, absolute
// cross-origin URLs do not. file://: every file: URL has an opaque ("null")
// origin, so an origin match is useless; instead require the URL to sit inside
// the document's own directory — no ../ escape, no absolute file:///… reads.
function isSameOriginSrc(url) {
  let u, base;
  try { u = new URL(url); base = new URL(location.href); } catch { return false; }
  if (base.protocol === "file:") {
    if (u.protocol !== "file:") return false;
    const dir = base.href.slice(0, base.href.lastIndexOf("/") + 1);
    return u.href.startsWith(dir);
  }
  return u.origin === base.origin && (u.protocol === "http:" || u.protocol === "https:");
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
