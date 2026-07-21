// GEML document-model → DOM. Pure: depends only on a DOM `document` (injectable
// for tests) and the chart renderer. KaTeX/Mermaid are NOT touched here — math
// and mermaid blocks become placeholder elements that content.js upgrades after
// injection, so this module stays testable under linkedom.

import { renderChart } from "./chart.js";

export function renderDocument(model, dom) {
  const root = dom.createElement("div");
  const diag = renderDiagnostics(model.diagnostics || [], dom);
  if (diag) root.appendChild(diag);

  const docEl = dom.createElement("div");
  docEl.className = "geml-doc";
  const labels = collectLabels(model.children);
  for (const b of model.children) {
    const node = renderBlock(b, dom, labels);
    if (node) docEl.appendChild(node);
  }
  root.appendChild(docEl);
  return root;
}

// Cross-document references (other.geml#id, other.md) can only be checked when
// a synchronous document resolver is available — which the browser has not. The
// parser then emits "not checked (no document resolver)" warnings for them. That
// is a limitation of viewing in a browser, not a problem with the document, so
// the viewer hides those while keeping every real diagnostic (errors, and other
// warnings). Pure + exported so it can be unit tested.
export function viewerDiagnostics(diags) {
  return (diags || []).filter(
    (d) => !(d.severity === "warning" && /no document resolver/.test(d.message)),
  );
}

// id → human label (heading text / block caption), for [[#id]] auto-references.
function collectLabels(children) {
  const labels = new Map();
  for (const b of children || []) {
    if (b.kind === "heading" && b.id) labels.set(b.id, b.text);
    else if (b.kind === "block" && b.id) {
      const cap = b.attrs && typeof b.attrs.caption === "string" ? b.attrs.caption : b.id;
      labels.set(b.id, cap);
    }
  }
  return labels;
}

function el(dom, tag, props, children) {
  const e = dom.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else e.setAttribute(k, String(v));
  }
  if (children) for (const c of children) if (c != null) e.appendChild(c);
  return e;
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

function renderInlines(inlines, dom, labels) {
  const frag = dom.createDocumentFragment();
  for (const n of inlines || []) frag.appendChild(renderInline(n, dom, labels));
  return frag;
}

function renderInline(n, dom, labels) {
  switch (n.type) {
    case "text": return dom.createTextNode(n.value);
    case "emph": return el(dom, "em", null, [renderInlines(n.children, dom, labels)]);
    case "strong": return el(dom, "strong", null, [renderInlines(n.children, dom, labels)]);
    case "strike": return el(dom, "del", null, [renderInlines(n.children, dom, labels)]);
    case "code": return el(dom, "code", { text: n.value });
    case "break": return dom.createElement("br");
    case "math": {
      // Placeholder; content.js renders with KaTeX. Fallback text is the source.
      return el(dom, "span", { class: "geml-math", "data-tex": n.value, text: n.value });
    }
    case "image": return renderMedia(n, dom);
    case "link": {
      const a = el(dom, "a", linkAttrs(n), [renderInlines(n.children, dom, labels)]);
      return a;
    }
    case "autoref": {
      const href = n.doc ? `${n.doc}${n.anchor ? "#" + n.anchor : ""}` : `#${n.anchor}`;
      const text = !n.doc && labels.has(n.anchor) ? labels.get(n.anchor) : (n.anchor || n.doc || "");
      const props = { class: "geml-autoref" };
      if (isSafeHref(href)) props.href = href; // drop javascript:/data:/… doc refs
      return el(dom, "a", props, [dom.createTextNode(text)]);
    }
    case "footnote":
      return el(dom, "sup", null, [el(dom, "a", { href: `#fn-${n.ref}` }, [dom.createTextNode(`[${n.ref}]`)])]);
    default:
      return dom.createTextNode("");
  }
}

// Scheme allowlist for any href/src built from a document-controlled
// destination. A crafted `[x](javascript:…)` (or data:, vbscript:, file:, …)
// must never become a live link. Mirrors the parser-side whitelist. A URL with
// no scheme prefix is a relative path or a bare `#anchor` — always safe; the
// only allowed *schemes* are http, https, mailto, tel.
const SAFE_HREF_SCHEME = /^(?:https?|mailto|tel):/i;
function schemeOf(url) {
  // A leading "letter + [a-z0-9+.-]* :" before any / ? # is a scheme. `//host`
  // (protocol-relative) and `#frag` / `path` have none. Strip every [\x00-\x20]
  // first: browsers drop embedded C0 controls/spaces before acting, so
  // `java\tscript:` would execute as javascript: unless we detect it here (R2-2).
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(String(url).replace(/[\x00-\x20]/g, ""));
  return m ? m[0] : null;
}
function isSafeHref(url) {
  if (typeof url !== "string") return false;
  const u = url.trim();
  if (u === "") return false;
  if (schemeOf(u) === null) return true; // relative path or #anchor
  return SAFE_HREF_SCHEME.test(u);
}
// Media src is stricter: it must not run script (scheme allowlist) AND it must
// not silently phone home. data: is inline (no network) so it is allowed; the
// only network schemes allowed inline are http(s), but those go through the
// remote-media gate below rather than auto-loading.
function isSafeMediaSrc(url) {
  if (typeof url !== "string") return false;
  const u = url.trim();
  if (u === "") return false;
  if (u.startsWith("//")) return true; // protocol-relative http(s)
  if (schemeOf(u) === null) return true; // relative path
  return /^(?:https?|data):/i.test(u);
}
// Remote = a third-party host the browser would connect to on load: an
// absolute http(s) URL or a protocol-relative `//host/…`.
function isRemoteSrc(url) {
  // Remote by SCHEME, not by counting slashes: `https:/host` (single slash)
  // normalizes to https://host in the browser and would auto-connect, so
  // slash-counting let it masquerade as local media (R2-6). schemeOf strips
  // control chars, so `http\ts:` can't dodge this either.
  const u = String(url).replace(/[\x00-\x20]/g, "");
  if (u.startsWith("//")) return true; // protocol-relative → remote
  const s = schemeOf(u);
  return s !== null && /^https?:$/i.test(s);
}
// Add rel tokens without dropping any the document already set.
function mergeRel(existing, add) {
  const set = new Set(String(existing || "").split(/\s+/).filter(Boolean));
  for (const t of add.split(/\s+/)) if (t) set.add(t);
  return [...set].join(" ");
}

function linkAttrs(n) {
  const a = {};
  let href;
  if (n.href) href = n.href;
  else if (n.anchor && !n.doc) href = `#${n.anchor}`;
  else if (n.doc) href = `${n.doc}${n.anchor ? "#" + n.anchor : ""}`;
  if (href && isSafeHref(href)) a.href = href; // else: inert (no href) — H1
  const at = n.attrs || {};
  if (at.target) {
    a.target = at.target;
    // L2 + privacy: a _blank link must not expose window.opener or leak the
    // referrer to the opened page.
    a.rel = at.target === "_blank" ? mergeRel(at.rel, "noopener noreferrer") : at.rel;
  } else if (at.rel) {
    a.rel = at.rel;
  }
  return a;
}

function renderMedia(n, dom) {
  const src = n.src;
  const kind = n.as || inferKind(src);
  // H1: neutralize unsafe schemes (javascript:, file:, …) — no src is emitted.
  if (!isSafeMediaSrc(src)) return el(dom, "span", { class: "geml-media-blocked", text: n.alt || "[media]" });
  // L1 / PRIVACY.md: remote media must not auto-load on open — that would leak
  // the viewer's IP and open-time to a third-party host (and, on file://, that a
  // local file was opened). Render an opt-in click-to-load link instead; local
  // (relative) and data: media still load inline as before.
  if (isRemoteSrc(src)) {
    return el(dom, "a", {
      class: "geml-remote-media",
      href: src,
      target: "_blank",
      rel: "noopener noreferrer",
      title: src,
      text: `▶ Load ${kind}: ${n.alt || src}`,
    }, []);
  }
  if (kind === "audio") return el(dom, "audio", { controls: "", src });
  if (kind === "video") return el(dom, "video", { controls: "", src, style: "max-width:100%" });
  return el(dom, "img", { src, alt: n.alt || "", style: "max-width:100%" });
}
function inferKind(src) {
  if (/\.(mp4|webm|mov|m4v|ogv|mkv)(?:[?#]|$)/i.test(src)) return "video";
  if (/\.(mp3|wav|ogg|oga|m4a|flac|aac|opus)(?:[?#]|$)/i.test(src)) return "audio";
  return "image";
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function renderBlock(b, dom, labels) {
  switch (b.kind) {
    case "heading": {
      const h = el(dom, `h${Math.min(6, b.level)}`, { id: b.id }, [renderInlines(b.inlines, dom, labels)]);
      return h;
    }
    case "paragraph":
      return el(dom, "p", null, [renderInlines(b.inlines, dom, labels)]);
    case "list": {
      const items = (b.items || []).map((it) => {
        const kids = [];
        if (it.checked !== undefined) {
          const box = { type: "checkbox", disabled: "" };
          if (it.checked) box.checked = "";
          kids.push(el(dom, "input", box, []));
        }
        kids.push(renderInlines(it.inlines, dom, labels));
        for (const child of it.children || []) {
          const c = renderBlock(child, dom, labels);
          if (c) kids.push(c);
        }
        const cls = it.checked === undefined ? null : it.checked ? "geml-task geml-task-done" : "geml-task";
        return el(dom, "li", cls ? { class: cls } : null, kids);
      });
      const props = b.ordered && b.start && b.start !== 1 ? { start: b.start } : null;
      return el(dom, b.ordered ? "ol" : "ul", props, items);
    }
    case "block":
      return renderTyped(b, dom, labels);
    default:
      return null;
  }
}

function renderTyped(b, dom, labels) {
  const type = b.type;
  if (type === "meta") return null; // document metadata, not shown
  if (type === "table" && b.table) return renderTable(b.table, dom, labels, b.id);
  if (type === "note") {
    const q = el(dom, "blockquote", { class: "geml-note", id: b.id });
    for (const c of b.children || []) { const n = renderBlock(c, dom, labels); if (n) q.appendChild(n); }
    return q;
  }
  if (type === "math") {
    return el(dom, "div", { class: "geml-block", id: b.id }, [
      el(dom, "div", { class: "geml-math-display", "data-tex": (b.raw || []).join("\n"), text: (b.raw || []).join("\n") }),
    ]);
  }
  if (type === "diagram") {
    const fmt = b.attrs && typeof b.attrs.format === "string" ? b.attrs.format : "";
    if (fmt === "geml-chart") {
      if (b.chart) return el(dom, "div", { class: "geml-chart", id: b.id }, [renderChart(b.chart, dom)]);
      return rawBlock(b, dom, "geml-chart (unresolved)");
    }
    if (fmt === "geml-code-graph") {
      // GEP-0003 embed: placeholder now; content.js/playground upgrade it
      // asynchronously (fetch the codemap slice, then run the shared runtime).
      const src = b.attrs && typeof b.attrs.src === "string" ? b.attrs.src : "";
      const wrap = el(dom, "figure", { class: "code-graph", id: b.id });
      if (!src) {
        wrap.appendChild(el(dom, "p", { class: "geml-cg-err", text: "geml-code-graph: missing src=" }));
        return wrap;
      }
      wrap.appendChild(el(dom, "div", { class: "cg-mount", "data-src": src, text: "loading code graph …" }));
      return wrap;
    }
    if (fmt === "mermaid") {
      const wrap = el(dom, "div", { class: "geml-block geml-diagram", id: b.id });
      // Source goes in a placeholder; content.js renders it with mermaid.render().
      // No "mermaid" class — we never want mermaid's own DOM scan to touch it.
      wrap.appendChild(el(dom, "div", { class: "geml-mermaid", text: (b.raw || []).join("\n") }));
      return wrap;
    }
    // D2 / Graphviz rendering is PARKED (only mermaid is popular enough to
    // ship for now). The engines are implemented and tested — see
    // build.mjs "PARKED ENGINES" for the full re-enable checklist. Until
    // then both formats take the labelled-source fallback below.
    // if (fmt === "d2") {
    //   const wrap = el(dom, "div", { class: "geml-block geml-diagram", id: b.id });
    //   // Source goes in a placeholder; content.js renders it via the sandboxed
    //   // D2 engine (see src/d2-sandbox.js). No "d2" class — nothing any library's
    //   // own DOM scan would pick up.
    //   wrap.appendChild(el(dom, "div", { class: "geml-d2", text: (b.raw || []).join("\n") }));
    //   return wrap;
    // }
    // if (fmt === "graphviz" || fmt === "dot") {
    //   const wrap = el(dom, "div", { class: "geml-block geml-diagram", id: b.id });
    //   // Source goes in a placeholder; content.js renders it via the sandboxed
    //   // Graphviz engine (see src/graphviz-sandbox.js). Both format aliases
    //   // share one placeholder class.
    //   wrap.appendChild(el(dom, "div", { class: "geml-graphviz", text: (b.raw || []).join("\n") }));
    //   return wrap;
    // }
    // plantuml / d2 / graphviz / unknown → source placeholder (§7 spirit)
    return rawBlock(b, dom, fmt || "diagram");
  }
  if (type === "code") {
    const lang = b.attrs && typeof b.attrs.lang === "string" ? b.attrs.lang : "";
    return rawBlock(b, dom, lang ? `code ${lang}` : "code");
  }
  // unknown typed block → show its raw body
  return rawBlock(b, dom, type);
}

function rawBlock(b, dom, tag) {
  const wrap = el(dom, "div", { class: "geml-block", id: b.id });
  wrap.appendChild(el(dom, "span", { class: "geml-tag", text: tag }));
  wrap.appendChild(el(dom, "pre", null, [el(dom, "code", { text: (b.raw || []).join("\n") })]));
  return wrap;
}

// ---------------------------------------------------------------------------
// Tables (§6) — header, alignment, computed columns, summary row, spans.
// ---------------------------------------------------------------------------

function renderTable(model, dom, labels, id) {
  // External data (src=) that was not inlined — render-time fetch failed or the
  // renderer didn't inline it. Show a placeholder rather than an empty table.
  if (model.src !== undefined) {
    return el(dom, "div", { class: "geml-block", id }, [
      el(dom, "span", { class: "geml-tag", text: "table · src" }),
      el(dom, "p", { text: `Data not loaded from ${model.src}` }),
    ]);
  }

  const table = el(dom, "table", { id });
  if (model.caption) table.appendChild(el(dom, "caption", { text: model.caption }));

  if (model.header) {
    const thead = el(dom, "thead");
    const tr = el(dom, "tr");
    for (const name of model.columns) tr.appendChild(el(dom, "th", null, [dom.createTextNode(name)]));
    thead.appendChild(tr);
    table.appendChild(thead);
  }

  const tbody = el(dom, "tbody");
  const covered = new Set(); // "r,c" cells hidden by a span above/left
  const rows = model.rows || [];
  rows.forEach((row, r) => tbody.appendChild(renderRow(row, r, model, dom, labels, covered, false)));
  if (model.summary) tbody.appendChild(renderRow(model.summary, rows.length, model, dom, labels, covered, true));
  table.appendChild(tbody);
  return table;
}

function renderRow(row, r, model, dom, labels, covered, isSummary) {
  const tr = el(dom, "tr", isSummary ? { class: "geml-summary" } : null);
  for (let c = 0; c < model.columns.length; c++) {
    if (covered.has(`${r},${c}`)) continue;
    const cell = row[c];
    const td = el(dom, "td");
    if (cell) {
      if (cell.inlines && cell.inlines.length) td.appendChild(renderInlines(cell.inlines, dom, labels));
      else td.textContent = cell.text || "";
      const align = cell.align || model.align[c];
      if (typeof cell.value === "number" || align === "right") td.className = "geml-num";
      else if (align === "center") td.style.textAlign = "center";
      if (cell.computed) td.className = (td.className ? td.className + " " : "") + "geml-computed";
      if (cell.span && (cell.span.rows > 1 || cell.span.cols > 1)) applySpan(td, cell.span, r, c, covered);
    }
    tr.appendChild(td);
  }
  return tr;
}

function applySpan(td, span, r, c, covered) {
  if (span.cols > 1) td.setAttribute("colspan", String(span.cols));
  if (span.rows > 1) td.setAttribute("rowspan", String(span.rows));
  for (let dr = 0; dr < span.rows; dr++)
    for (let dc = 0; dc < span.cols; dc++)
      if (dr || dc) covered.add(`${r + dr},${c + dc}`);
}

// ---------------------------------------------------------------------------
// Diagnostics banner (§8) — surfaces build-time errors/warnings.
// ---------------------------------------------------------------------------

function renderDiagnostics(diags, dom) {
  const errs = diags.filter((d) => d.severity === "error");
  const warns = diags.filter((d) => d.severity === "warning");
  if (!errs.length && !warns.length) return null;
  const wrap = dom.createDocumentFragment();
  if (errs.length) wrap.appendChild(diagBox(errs, "error", dom));
  if (warns.length) wrap.appendChild(diagBox(warns, "warn", dom));
  return wrap;
}

function diagBox(items, kind, dom) {
  const box = el(dom, "div", { class: `geml-diag geml-diag-${kind}` });
  box.appendChild(el(dom, "strong", { text: `${items.length} ${kind === "error" ? "error" : "warning"}${items.length > 1 ? "s" : ""}` }));
  const ul = el(dom, "ul");
  for (const d of items) ul.appendChild(el(dom, "li", { text: d.line ? `line ${d.line}: ${d.message}` : d.message }));
  box.appendChild(ul);
  return box;
}
