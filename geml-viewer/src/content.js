// Content script: detect a .geml document, parse it with the reference parser,
// render it to DOM, and upgrade math (KaTeX) and mermaid diagrams. Runs once at
// document_idle on URLs narrowed by include_globs in the manifest.

import { parse } from "./parse-entry.js";
import { renderDocument, viewerDiagnostics } from "./render.js";
import { hasSrcTable, inlineSrcTables, looksTabular } from "./inline-src.js";
import { upgradeMath, upgradeMermaid } from "./upgrade.js";
import css from "./geml.css";
import katex from "katex";
import katexCss from "katex/dist/katex.css";
import mermaid from "mermaid";

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
  await upgradeMermaid(document, mermaid);
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
