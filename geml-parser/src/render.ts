// GEML reference renderer — P0 runtime: a GEML document -> one self-contained,
// interactive HTML artifact.
//
// What an agent hands a person is the `.geml` file. This runtime turns it into a
// page a browser can open and *use*: prose and headings, callouts, code, math,
// diagrams, tables you can sort and filter, and charts drawn as inline SVG
// straight from their bound table (no second copy of the data).
//
// Self-containment: the CSS, the table interactivity, and every chart are inlined
// into the single HTML file. Math (KaTeX) and Mermaid diagrams are the one
// exception. They load from a CDN, and only when the document actually uses them,
// so a document of prose, tables and charts is fully self-contained with zero
// network. Bundling those two engines offline is the next step (roadmap P0 #6).

import { type Block, type Document } from "./geml.js";
import { type Inline } from "./inline.js";
import { type Align, type TableCell, type TableModel } from "./table.js";
import { type ChartModel } from "./chart.js";
import { type Value } from "./attrs.js";

const PALETTE = ["#2563eb", "#dc2626", "#059669", "#d97706", "#7c3aed", "#db2777", "#0891b2", "#ea580c"];

export interface RenderOptions {
  title?: string;
  source?: string; // source file name, shown in the footer
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escAttr(s: string): string {
  return esc(s).replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Render context
// ---------------------------------------------------------------------------

class RenderCtx {
  usedMath = false;
  usedMermaid = false;
  labels = new Map<string, string>(); // id -> link label for [[#id]] auto-refs

  constructor(private doc: Document) {
    this.indexLabels(doc.children);
  }

  // Build the id -> label map: a heading's text, or a block's caption, or its id.
  private indexLabels(blocks: Block[]): void {
    for (const b of blocks) {
      if (b.kind === "heading") this.labels.set(b.id ?? "", b.text);
      else if (b.kind === "block") {
        if (b.id) {
          const cap = b.attrs["caption"];
          this.labels.set(b.id, typeof cap === "string" ? cap : (b.table?.caption ?? b.id));
        }
        if (b.children) this.indexLabels(b.children);
      }
    }
  }

  docTitle(): string | undefined {
    for (const b of this.doc.children) {
      if (b.kind === "block" && b.type === "meta" && b.data && typeof b.data["title"] === "string") {
        return b.data["title"] as string;
      }
    }
    for (const b of this.doc.children) if (b.kind === "heading") return b.text;
    return undefined;
  }

  // ----- inline -----

  inlines(ns: Inline[]): string {
    return ns.map((n) => this.inline(n)).join("");
  }

  private inline(n: Inline): string {
    switch (n.type) {
      case "text": return esc(n.value);
      case "emph": return `<em>${this.inlines(n.children)}</em>`;
      case "strong": return `<strong>${this.inlines(n.children)}</strong>`;
      case "strike": return `<del>${this.inlines(n.children)}</del>`;
      case "code": return `<code>${esc(n.value)}</code>`;
      case "math": this.usedMath = true; return `<span class="math">\\(${esc(n.value)}\\)</span>`;
      case "break": return "<br>\n";
      case "image": return this.media(n);
      case "link": return this.link(n);
      case "autoref": {
        const href = n.doc ? `${n.doc.replace(/\.geml$/, ".html")}#${n.anchor}` : `#${n.anchor}`;
        const label = n.doc ? (n.anchor ?? n.doc) : (this.labels.get(n.anchor) ?? n.anchor);
        return `<a href="${escAttr(href)}">${esc(label)}</a>`;
      }
      case "footnote": return `<sup class="fn"><a href="#${escAttr(n.ref)}">${esc(n.ref)}</a></sup>`;
    }
  }

  private media(n: Extract<Inline, { type: "image" }>): string {
    const src = escAttr(n.src);
    if (n.as === "video") return `<video class="media" src="${src}" controls></video>`;
    if (n.as === "audio") return `<audio class="media" src="${src}" controls></audio>`;
    return `<img class="media" src="${src}" alt="${escAttr(n.alt)}">`;
  }

  private link(n: Extract<Inline, { type: "link" }>): string {
    let href = "#";
    if (n.href) href = n.href;
    else if (n.doc) href = `${n.doc.replace(/\.geml$/, ".html")}${n.anchor ? "#" + n.anchor : ""}`;
    else if (n.anchor) href = `#${n.anchor}`;
    const rel = typeof n.attrs["rel"] === "string" ? ` rel="${escAttr(n.attrs["rel"] as string)}"` : "";
    const target = typeof n.attrs["target"] === "string" ? ` target="${escAttr(n.attrs["target"] as string)}"` : "";
    return `<a href="${escAttr(href)}"${rel}${target}>${this.inlines(n.children)}</a>`;
  }

  // ----- blocks -----

  block(b: Block): string {
    switch (b.kind) {
      case "hidden": return "";
      case "heading": {
        if (b.hidden) return "";
        const id = b.id ? ` id="${escAttr(b.id)}"` : "";
        const lvl = Math.min(6, Math.max(1, b.level));
        return `<h${lvl}${id}>${this.inlines(b.inlines)}</h${lvl}>`;
      }
      case "paragraph": {
        const html = this.inlines(b.inlines).trim();
        return html === "" ? "" : `<p>${html}</p>`;
      }
      case "list": {
        const tag = b.ordered ? "ol" : "ul";
        const isTask = b.items.some((it) => it.checked !== undefined);
        const items = b.items.map((it) => {
          const inner = this.inlines(it.inlines);
          if (it.checked === undefined) return `  <li>${inner}</li>`;
          const box = `<input type="checkbox" disabled${it.checked ? " checked" : ""}> `;
          return `  <li class="task">${box}${inner}</li>`;
        }).join("\n");
        return `<${tag}${isTask ? ' class="task-list"' : ""}>\n${items}\n</${tag}>`;
      }
      case "block": return this.typed(b);
    }
  }

  private typed(b: Extract<Block, { kind: "block" }>): string {
    if (b.hidden) return ""; // {hidden}: in the model, never rendered
    const raw = (b.raw ?? []).join("\n");
    const caption = typeof b.attrs["caption"] === "string" ? (b.attrs["caption"] as string) : undefined;
    const idAttr = b.id ? ` id="${escAttr(b.id)}"` : "";

    switch (b.type) {
      case "meta": return ""; // header metadata, not body content
      case "code": {
        const lang = typeof b.attrs["lang"] === "string" ? (b.attrs["lang"] as string) : "";
        const cls = lang ? ` class="language-${escAttr(lang)}"` : "";
        return `<pre${idAttr}><code${cls}>${esc(raw)}</code></pre>`;
      }
      case "output":
        return `<pre class="output"${idAttr}><code>${esc(raw)}</code></pre>`;
      case "math":
        this.usedMath = true;
        return `<div class="math-block"${idAttr}>\\[${esc(raw)}\\]</div>`;
      case "note":
      case "aside": {
        const classes = ["callout", b.type, ...b.classes].join(" ");
        const inner = (b.children ?? []).map((c) => this.block(c)).filter((s) => s).join("\n");
        return `<aside class="${classes}"${idAttr}>\n${inner}\n</aside>`;
      }
      case "table":
        return b.table ? this.table(b.table, b.id, caption) : `<p class="render-error">table failed to parse</p>`;
      case "diagram":
        return this.diagram(b, raw, caption);
      default: {
        // Unknown type: preserved as raw (spec §3). Show it, labelled.
        return `<figure${idAttr}><pre class="diagram-src" data-type="${escAttr(b.type)}">${esc(raw)}</pre>` +
          `<figcaption>unknown block type <code>${esc(b.type)}</code>; shown as raw</figcaption></figure>`;
      }
    }
  }

  private diagram(b: Extract<Block, { kind: "block" }>, raw: string, caption?: string): string {
    const idAttr = b.id ? ` id="${escAttr(b.id)}"` : "";
    const fmt = typeof b.attrs["format"] === "string" ? (b.attrs["format"] as string) : "";
    const cap = caption ? `<figcaption>${esc(caption)}</figcaption>` : "";

    if (fmt === "geml-chart") {
      if (b.chart) return `<figure class="chart"${idAttr}>${chartSvg(b.chart, caption)}${cap}</figure>`;
      return `<figure${idAttr}><p class="render-error">chart could not be built (see diagnostics)</p>${cap}</figure>`;
    }
    if (fmt === "mermaid") {
      this.usedMermaid = true;
      return `<figure${idAttr}><pre class="mermaid">${esc(raw)}</pre>${cap}</figure>`;
    }
    // graphviz / d2 / plantuml / vega-lite / unknown: no bundled engine yet.
    return `<figure${idAttr}><pre class="diagram-src" data-format="${escAttr(fmt)}">${esc(raw)}</pre>` +
      `<figcaption>${caption ? esc(caption) + " — " : ""}<code>${esc(fmt || "diagram")}</code> (no bundled renderer in this build)</figcaption></figure>`;
  }

  private table(t: TableModel, id?: string, caption?: string): string {
    const idAttr = id ? ` id="${escAttr(id)}"` : "";
    const alignStyle = (a?: Align) => (a ? ` style="text-align:${a}"` : "");

    // Coverage grid for declared spans, so cells a span covers are not emitted.
    const covered = t.rows.map((r) => r.map(() => false));
    t.rows.forEach((row, r) => row.forEach((cell, c) => {
      if (!cell.span) return;
      for (let dr = 0; dr < cell.span.rows; dr++)
        for (let dc = 0; dc < cell.span.cols; dc++) {
          if (dr === 0 && dc === 0) continue;
          const rr = r + dr, cc = c + dc;
          if (covered[rr]?.[cc] !== undefined) covered[rr]![cc] = true;
        }
    }));

    const thead = t.header
      ? `<thead><tr>${t.columns.map((col, c) => `<th${alignStyle(t.align[c])}>${esc(col)}</th>`).join("")}</tr></thead>`
      : "";

    const bodyRows = t.rows.map((row, r) => {
      const cells = row.map((cell, c) => {
        if (covered[r]?.[c]) return "";
        const span = cell.span ? `${cell.span.rows > 1 ? ` rowspan="${cell.span.rows}"` : ""}${cell.span.cols > 1 ? ` colspan="${cell.span.cols}"` : ""}` : "";
        const cls = cell.computed ? ' class="computed"' : "";
        const sortVal = typeof cell.value === "number" ? ` data-sort="${cell.value}"` : "";
        return `<td${alignStyle(cell.align ?? t.align[c])}${span}${cls}${sortVal}>${this.inlines(cell.inlines)}</td>`;
      }).join("");
      return `<tr>${cells}</tr>`;
    }).join("\n");

    const tfoot = t.summary
      ? `<tfoot><tr>${t.summary.map((cell, c) => {
          const sortVal = typeof cell.value === "number" ? ` data-sort="${cell.value}"` : "";
          return `<td${alignStyle(cell.align ?? t.align[c])}${sortVal}>${this.inlines(cell.inlines)}</td>`;
        }).join("")}</tr></tfoot>`
      : "";

    const cap = caption ? `<figcaption>${esc(caption)}</figcaption>` : "";
    const tools = `<div class="table-tools"><input class="table-filter" type="search" placeholder="Filter rows…" aria-label="Filter table rows"></div>`;
    return `<figure class="table-figure"${idAttr}>${tools}` +
      `<table class="geml-table">${thead}<tbody>\n${bodyRows}\n</tbody>${tfoot}</table>${cap}</figure>`;
  }
}

// ---------------------------------------------------------------------------
// Charts: a ChartModel -> inline SVG (fully self-contained, no dependency)
// ---------------------------------------------------------------------------

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / pow;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * pow;
}

function chartSvg(m: ChartModel, title?: string): string {
  if (m.type === "pie") return pieSvg(m, title);
  if (m.type === "scatter") return scatterSvg(m, title);
  return cartesianSvg(m, title); // bar | line | area
}

function svgFrame(title: string | undefined, W: number, H: number, body: string): string {
  const t = title ? `<text x="${W / 2}" y="22" text-anchor="middle" class="c-title">${esc(title)}</text>` : "";
  return `<svg viewBox="0 0 ${W} ${H}" class="geml-chart" role="img" aria-label="${escAttr(title ?? "chart")}">${t}${body}</svg>`;
}

function legend(names: string[], x: number, y: number): string {
  return names.map((n, i) => {
    const yy = y + i * 18;
    return `<rect x="${x}" y="${yy}" width="11" height="11" rx="2" fill="${PALETTE[i % PALETTE.length]}"></rect>` +
      `<text x="${x + 16}" y="${yy + 10}" class="c-legend">${esc(n)}</text>`;
  }).join("");
}

function cartesianSvg(m: ChartModel, title?: string): string {
  const W = 760, H = 380;
  const top = title ? 40 : 22, right = 20, bottom = 64, left = 56;
  const pw = W - left - right, ph = H - top - bottom;
  const cats = m.dataset.categories;
  const series = m.y;
  const vals = series.map((s) => m.dataset.numbers[s] ?? []);
  const flat = vals.flat();
  const dataMax = Math.max(0, ...flat);
  const dataMin = Math.min(0, ...flat);
  const yMax = niceMax(dataMax);
  const yMin = dataMin < 0 ? -niceMax(-dataMin) : 0;
  const range = yMax - yMin || 1;
  const yOf = (v: number) => top + ph * (1 - (v - yMin) / range);
  const n = Math.max(1, cats.length);
  const band = pw / n;
  const cx = (i: number) => left + band * (i + 0.5);

  // y grid + ticks
  const ticks = 5;
  let grid = "";
  for (let i = 0; i <= ticks; i++) {
    const v = yMin + (range * i) / ticks;
    const y = yOf(v);
    grid += `<line x1="${left}" y1="${y}" x2="${left + pw}" y2="${y}" class="c-grid"></line>`;
    grid += `<text x="${left - 8}" y="${y + 4}" text-anchor="end" class="c-tick">${fmtNum(v)}</text>`;
  }
  // x labels
  let xlab = "";
  cats.forEach((c, i) => {
    xlab += `<text x="${cx(i)}" y="${top + ph + 18}" text-anchor="middle" class="c-tick">${esc(trunc(c, 12))}</text>`;
  });

  let marks = "";
  if (m.type === "bar") {
    const groupW = band * 0.8;
    const bw = groupW / series.length;
    series.forEach((s, si) => {
      (m.dataset.numbers[s] ?? []).forEach((v, i) => {
        const x = cx(i) - groupW / 2 + si * bw;
        const y0 = yOf(0), y1 = yOf(v);
        const y = Math.min(y0, y1), h = Math.abs(y1 - y0);
        marks += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.92).toFixed(1)}" height="${h.toFixed(1)}" fill="${PALETTE[si % PALETTE.length]}"><title>${esc(s)} · ${esc(cats[i] ?? "")}: ${fmtNum(v)}</title></rect>`;
      });
    });
  } else {
    // line / area
    series.forEach((s, si) => {
      const color = PALETTE[si % PALETTE.length];
      const pts = (m.dataset.numbers[s] ?? []).map((v, i) => `${cx(i).toFixed(1)},${yOf(v).toFixed(1)}`);
      if (pts.length === 0) return;
      if (m.type === "area") {
        const base = yOf(Math.max(yMin, 0));
        marks += `<polygon points="${cx(0).toFixed(1)},${base} ${pts.join(" ")} ${cx(cats.length - 1).toFixed(1)},${base}" fill="${color}" fill-opacity="0.18"></polygon>`;
      }
      marks += `<polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="2.5"></polyline>`;
      (m.dataset.numbers[s] ?? []).forEach((v, i) => {
        marks += `<circle cx="${cx(i).toFixed(1)}" cy="${yOf(v).toFixed(1)}" r="3.5" fill="${color}"><title>${esc(s)} · ${esc(cats[i] ?? "")}: ${fmtNum(v)}</title></circle>`;
      });
    });
  }

  const axis = `<line x1="${left}" y1="${yOf(Math.max(yMin, 0))}" x2="${left + pw}" y2="${yOf(Math.max(yMin, 0))}" class="c-axis"></line>`;
  const leg = series.length > 1 ? legend(series, left + 8, top + 4) : "";
  return svgFrame(title, W, H, grid + axis + marks + xlab + leg);
}

function pieSvg(m: ChartModel, title?: string): string {
  const W = 760, H = 380, top = title ? 40 : 22;
  const cx = 250, cy = top + (H - top) / 2, r = Math.min(140, (H - top) / 2 - 16);
  const col = m.y[0]!;
  const data = m.dataset.numbers[col] ?? [];
  const total = data.reduce((a, b) => a + b, 0) || 1;
  let a0 = -Math.PI / 2;
  let slices = "";
  data.forEach((v, i) => {
    const a1 = a0 + (v / total) * Math.PI * 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    slices += `<path d="M${cx},${cy} L${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 ${large} 1 ${x1.toFixed(1)},${y1.toFixed(1)} Z" fill="${PALETTE[i % PALETTE.length]}"><title>${esc(m.dataset.categories[i] ?? "")}: ${fmtNum(v)} (${((v / total) * 100).toFixed(1)}%)</title></path>`;
    a0 = a1;
  });
  const leg = legend(m.dataset.categories, 470, top + 16);
  return svgFrame(title, W, H, slices + leg);
}

function scatterSvg(m: ChartModel, title?: string): string {
  const W = 760, H = 380;
  const top = title ? 40 : 22, right = 20, bottom = 64, left = 56;
  const pw = W - left - right, ph = H - top - bottom;
  const yCol = m.y[0]!;
  const ys = m.dataset.numbers[yCol] ?? [];
  // x: parse the category text as a number; fall back to the row index.
  const xs = m.dataset.categories.map((c, i) => { const v = parseFloat(c); return Number.isFinite(v) ? v : i; });
  const sizes = m.size ? (m.dataset.numbers[m.size] ?? []) : [];
  const xMax = niceMax(Math.max(1, ...xs)), xMin = Math.min(0, ...xs);
  const yMax = niceMax(Math.max(1, ...ys)), yMin = Math.min(0, ...ys);
  const xr = xMax - xMin || 1, yr = yMax - yMin || 1;
  const xOf = (v: number) => left + pw * ((v - xMin) / xr);
  const yOf = (v: number) => top + ph * (1 - (v - yMin) / yr);
  const sMax = Math.max(1, ...sizes);
  const rOf = (i: number) => m.size ? 4 + 14 * Math.sqrt((sizes[i] ?? 0) / sMax) : 5;

  let grid = "";
  for (let i = 0; i <= 5; i++) {
    const v = yMin + (yr * i) / 5, y = yOf(v);
    grid += `<line x1="${left}" y1="${y}" x2="${left + pw}" y2="${y}" class="c-grid"></line>`;
    grid += `<text x="${left - 8}" y="${y + 4}" text-anchor="end" class="c-tick">${fmtNum(v)}</text>`;
  }
  let pts = "";
  ys.forEach((v, i) => {
    pts += `<circle cx="${xOf(xs[i] ?? 0).toFixed(1)}" cy="${yOf(v).toFixed(1)}" r="${rOf(i).toFixed(1)}" fill="${PALETTE[0]}" fill-opacity="0.7"><title>${esc(m.dataset.categories[i] ?? "")}: (${fmtNum(xs[i] ?? 0)}, ${fmtNum(v)})</title></circle>`;
  });
  const axis = `<line x1="${left}" y1="${top + ph}" x2="${left + pw}" y2="${top + ph}" class="c-axis"></line>`;
  return svgFrame(title, W, H, grid + axis + pts);
}

function fmtNum(v: number): string {
  if (Math.abs(v) >= 1000) return v.toLocaleString("en-US");
  return String(parseFloat(v.toPrecision(4)));
}
function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ---------------------------------------------------------------------------
// Page shell, inline CSS, inline interactivity JS
// ---------------------------------------------------------------------------

const CSS = `
:root { --fg:#1f2328; --muted:#656d76; --bd:#d0d7de; --bg:#fff; --accent:#2563eb; --code-bg:#f6f8fa; }
* { box-sizing: border-box; }
body { margin:0; color:var(--fg); background:#fafbfc; font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,"PingFang SC","Microsoft Yahei",sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 48px 24px 96px; background:var(--bg); }
h1,h2,h3,h4,h5,h6 { line-height:1.25; margin:1.6em 0 .6em; scroll-margin-top:16px; }
h1 { font-size:2em; border-bottom:1px solid var(--bd); padding-bottom:.3em; }
h2 { font-size:1.5em; border-bottom:1px solid var(--bd); padding-bottom:.3em; }
h3 { font-size:1.25em; } h4 { font-size:1em; }
p { margin:.7em 0; }
a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
code { background:var(--code-bg); padding:.15em .35em; border-radius:6px; font:.88em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
pre { background:var(--code-bg); padding:14px 16px; border-radius:8px; overflow:auto; }
pre code { background:none; padding:0; font-size:.85em; }
pre.output { background:#0d1117; color:#e6edf3; }
pre.output code { color:inherit; }
ul,ol { padding-left:1.6em; } li { margin:.2em 0; }
ul.task-list { list-style:none; padding-left:.2em; } li.task input { margin-right:.5em; }
aside.callout { border-left:4px solid var(--accent); background:#f0f6ff; padding:.4em 16px; border-radius:0 8px 8px 0; margin:1em 0; }
aside.aside { border-left-color:#8b949e; background:#f6f8fa; }
aside.warning { border-left-color:#d97706; background:#fff8f0; }
aside.callout > :first-child { margin-top:0; } aside.callout > :last-child { margin-bottom:0; }
figure { margin:1.2em 0; }
figcaption { color:var(--muted); font-size:.86em; text-align:center; margin-top:.5em; }
table.geml-table { border-collapse:collapse; width:100%; font-size:.92em; }
table.geml-table th, table.geml-table td { border:1px solid var(--bd); padding:6px 12px; }
table.geml-table thead th { background:var(--code-bg); cursor:pointer; user-select:none; white-space:nowrap; }
table.geml-table thead th::after { content:" \\2195"; color:var(--muted); font-size:.8em; }
table.geml-table thead th.asc::after { content:" \\2191"; color:var(--accent); }
table.geml-table thead th.desc::after { content:" \\2193"; color:var(--accent); }
table.geml-table tbody tr:nth-child(2n) { background:#fafbfc; }
table.geml-table td.computed { color:#0a7c52; }
table.geml-table tfoot td { background:var(--code-bg); font-weight:600; border-top:2px solid var(--bd); }
.table-tools { margin-bottom:6px; } .table-filter { width:240px; max-width:100%; padding:5px 9px; border:1px solid var(--bd); border-radius:7px; font-size:.85em; }
.geml-chart { width:100%; height:auto; background:var(--bg); border:1px solid var(--bd); border-radius:8px; }
.c-title { font-size:15px; font-weight:600; fill:var(--fg); }
.c-grid { stroke:#eaecef; } .c-axis { stroke:#aab1b8; } .c-tick { font-size:11px; fill:var(--muted); } .c-legend { font-size:12px; fill:var(--fg); }
.media { max-width:100%; border-radius:8px; }
.diagram-src { color:var(--muted); } .render-error { color:#cf222e; }
.math-block { overflow-x:auto; padding:.4em 0; }
sup.fn a { font-size:.75em; }
.geml-footer { max-width:860px; margin:0 auto; padding:16px 24px 40px; color:var(--muted); font-size:.82em; }
.geml-footer code { font-size:.95em; }
`;

const JS = `
(function () {
  function cmp(a, b) {
    var na = a.dataset.sort, nb = b.dataset.sort;
    if (na !== undefined && nb !== undefined) return parseFloat(na) - parseFloat(nb);
    return (a.textContent || "").localeCompare(b.textContent || "");
  }
  document.querySelectorAll("table.geml-table").forEach(function (table) {
    var tbody = table.tBodies[0];
    if (!tbody) return;
    // Sort on header click.
    var ths = table.tHead ? table.tHead.rows[0].cells : [];
    Array.prototype.forEach.call(ths, function (th, col) {
      th.addEventListener("click", function () {
        var dir = th.classList.contains("asc") ? "desc" : "asc";
        Array.prototype.forEach.call(ths, function (h) { h.classList.remove("asc", "desc"); });
        th.classList.add(dir);
        var rows = Array.prototype.slice.call(tbody.rows);
        rows.sort(function (r1, r2) {
          var c = cmp(r1.cells[col], r2.cells[col]);
          return dir === "asc" ? c : -c;
        });
        rows.forEach(function (r) { tbody.appendChild(r); });
      });
    });
    // Filter rows.
    var fig = table.closest(".table-figure");
    var input = fig ? fig.querySelector(".table-filter") : null;
    if (input) input.addEventListener("input", function () {
      var q = input.value.toLowerCase();
      Array.prototype.forEach.call(tbody.rows, function (r) {
        r.style.display = (r.textContent || "").toLowerCase().indexOf(q) >= 0 ? "" : "none";
      });
    });
  });
})();
`;

function page(title: string, body: string, ctx: RenderCtx, source?: string): string {
  const mathHead = ctx.usedMath
    ? `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">\n` +
      `<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>\n` +
      `<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js" onload="renderMathInElement(document.body,{delimiters:[{left:'\\\\[',right:'\\\\]',display:true},{left:'\\\\(',right:'\\\\)',display:false}]})"></script>\n`
    : "";
  const mermaidHead = ctx.usedMermaid
    ? `<script type="module">import m from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";m.initialize({startOnLoad:true});</script>\n`
    : "";
  const footer = source
    ? `<footer class="geml-footer">Rendered from <code>${esc(source)}</code> by the GEML runtime. Tables are sortable and filterable; the chart is inline SVG drawn from its bound table.</footer>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
${mathHead}${mermaidHead}</head>
<body>
<main>
${body}
</main>
${footer}
<script>${JS}</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export function renderHtml(doc: Document, opts: RenderOptions = {}): string {
  const ctx = new RenderCtx(doc);
  const body = doc.children.map((b) => ctx.block(b)).filter((s) => s !== "").join("\n");
  const title = opts.title ?? ctx.docTitle() ?? "GEML document";
  return page(title, body, ctx, opts.source);
}
