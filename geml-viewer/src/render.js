// GEML document-model → DOM. Pure: depends only on a DOM `document` (injectable
// for tests) and the chart renderer. KaTeX/Mermaid are NOT touched here — math
// and mermaid blocks become placeholder elements that content.js upgrades after
// injection, so this module stays testable under linkedom.

import { renderChart } from "./chart.js";

const RAW_DIAGRAM_FALLBACK = new Set(["graphviz", "dot", "d2", "plantuml"]);

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
      return el(dom, "a", { href, class: "geml-autoref" }, [dom.createTextNode(text)]);
    }
    case "footnote":
      return el(dom, "sup", null, [el(dom, "a", { href: `#fn-${n.ref}` }, [dom.createTextNode(`[${n.ref}]`)])]);
    default:
      return dom.createTextNode("");
  }
}

function linkAttrs(n) {
  const a = {};
  if (n.href) a.href = n.href;
  else if (n.anchor && !n.doc) a.href = `#${n.anchor}`;
  else if (n.doc) a.href = `${n.doc}${n.anchor ? "#" + n.anchor : ""}`;
  const at = n.attrs || {};
  if (at.target) a.target = at.target;
  if (at.rel) a.rel = at.rel;
  return a;
}

function renderMedia(n, dom) {
  const kind = n.as || inferKind(n.src);
  if (kind === "audio") return el(dom, "audio", { controls: "", src: n.src });
  if (kind === "video") return el(dom, "video", { controls: "", src: n.src, style: "max-width:100%" });
  return el(dom, "img", { src: n.src, alt: n.alt || "", style: "max-width:100%" });
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
      const list = el(dom, b.ordered ? "ol" : "ul", null,
        (b.items || []).map((it) => el(dom, "li", null, [renderInlines(it.inlines, dom, labels)])));
      return list;
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
  if (type === "note" || type === "aside") {
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
    if (fmt === "mermaid") {
      const wrap = el(dom, "div", { class: "geml-block geml-diagram", id: b.id });
      // Source goes in a placeholder; content.js renders it with mermaid.render().
      // No "mermaid" class — we never want mermaid's own DOM scan to touch it.
      wrap.appendChild(el(dom, "div", { class: "geml-mermaid", text: (b.raw || []).join("\n") }));
      return wrap;
    }
    // graphviz / d2 / plantuml / unknown → source placeholder (§7 spirit)
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
