// geml-chart ChartModel → inline SVG. Pure (DOM only), no external library.
// Consumes the model produced by geml-parser's buildChart:
//   { type, x, y[], series?, size?, dataset: { categories, numbers, seriesOf? } }

const NS = "http://www.w3.org/2000/svg";
const PALETTE = ["#0969da", "#1a7f37", "#bf3989", "#9a6700", "#cf222e", "#8250df", "#0550ae"];
const W = 640, H = 360, M = { top: 20, right: 20, bottom: 56, left: 56 };

export function renderChart(model, dom) {
  const frag = dom.createDocumentFragment();
  const svg = svgEl(dom, "svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", role: "img" });
  const t = tabulate(model);
  try {
    if (model.type === "pie") drawPie(svg, dom, t);
    else if (model.type === "scatter") drawScatter(svg, dom, model, t);
    else if (model.type === "line" || model.type === "area") drawLines(svg, dom, t, model.type === "area");
    else drawBars(svg, dom, t);
  } catch {
    svg.appendChild(svgEl(dom, "text", { x: 20, y: 30, fill: "#cf222e" }, "chart could not be drawn"));
  }
  frag.appendChild(svg);
  if (model.type !== "pie" && t.series.length > 1) frag.appendChild(legend(dom, t.series));
  else if (model.type === "pie") frag.appendChild(legend(dom, t.cats));
  return frag;
}

// Normalize to { cats:string[], series:string[], get(seriesName, catIndex)→number|null }.
function tabulate(model) {
  const ds = model.dataset;
  if (model.series && ds.seriesOf) {
    const y0 = model.y[0];
    const col = ds.numbers[y0] || [];
    const cats = uniq(ds.categories);
    const series = uniq(ds.seriesOf);
    const map = new Map(series.map((s) => [s, new Array(cats.length).fill(null)]));
    ds.categories.forEach((cat, i) => {
      const row = map.get(ds.seriesOf[i]);
      const ci = cats.indexOf(cat);
      if (row && ci >= 0) row[ci] = col[i];
    });
    return { cats, series, get: (s, ci) => map.get(s)[ci] };
  }
  const series = model.y;
  return { cats: ds.categories, series, get: (s, ci) => (ds.numbers[s] ? ds.numbers[s][ci] : null) };
}

function uniq(a) { const out = []; for (const x of a) if (!out.includes(x)) out.push(x); return out; }

function extent(t) {
  let max = 0, min = 0;
  for (const s of t.series) for (let i = 0; i < t.cats.length; i++) {
    const v = t.get(s, i);
    if (typeof v === "number") { if (v > max) max = v; if (v < min) min = v; }
  }
  return { min, max: max === min ? max + 1 : max };
}

function svgEl(dom, tag, attrs, text) {
  const e = dom.createElementNS(NS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text != null) e.textContent = String(text);
  return e;
}

function yScale(ext) {
  const h = H - M.top - M.bottom;
  return (v) => M.top + h - ((v - ext.min) / (ext.max - ext.min)) * h;
}

function axes(svg, dom, ext, cats) {
  const y0 = yScale(ext)(ext.min < 0 ? 0 : ext.min);
  // y grid + labels (4 ticks)
  const ys = yScale(ext);
  for (let k = 0; k <= 4; k++) {
    const v = ext.min + ((ext.max - ext.min) * k) / 4;
    const y = ys(v);
    svg.appendChild(svgEl(dom, "line", { x1: M.left, y1: y, x2: W - M.right, y2: y, stroke: "#eaecef" }));
    svg.appendChild(svgEl(dom, "text", { x: M.left - 8, y: y + 4, "text-anchor": "end", "font-size": 11, fill: "#6e7781" }, fmt(v)));
  }
  // x labels
  const bw = (W - M.left - M.right) / cats.length;
  cats.forEach((c, i) => {
    svg.appendChild(svgEl(dom, "text", { x: M.left + bw * (i + 0.5), y: H - M.bottom + 18, "text-anchor": "middle", "font-size": 11, fill: "#6e7781" }, c));
  });
  svg.appendChild(svgEl(dom, "line", { x1: M.left, y1: y0, x2: W - M.right, y2: y0, stroke: "#afb8c1" }));
}

function fmt(v) { return Math.abs(v) >= 1000 ? v.toFixed(0) : String(Math.round(v * 100) / 100); }

function drawBars(svg, dom, t) {
  const ext = extent(t);
  axes(svg, dom, ext, t.cats);
  const ys = yScale(ext);
  const groupW = (W - M.left - M.right) / t.cats.length;
  const barW = (groupW * 0.7) / t.series.length;
  const base = ys(ext.min < 0 ? 0 : ext.min);
  t.cats.forEach((c, ci) => {
    t.series.forEach((s, si) => {
      const v = t.get(s, ci);
      if (typeof v !== "number") return;
      const x = M.left + groupW * ci + groupW * 0.15 + barW * si;
      const y = ys(v);
      svg.appendChild(svgEl(dom, "rect", { x, y: Math.min(y, base), width: barW, height: Math.abs(base - y), fill: PALETTE[si % PALETTE.length], rx: 2 }));
    });
  });
}

function drawLines(svg, dom, t, fill) {
  const ext = extent(t);
  axes(svg, dom, ext, t.cats);
  const ys = yScale(ext);
  const groupW = (W - M.left - M.right) / t.cats.length;
  const xAt = (ci) => M.left + groupW * (ci + 0.5);
  const base = ys(ext.min < 0 ? 0 : ext.min);
  t.series.forEach((s, si) => {
    const pts = [];
    t.cats.forEach((c, ci) => { const v = t.get(s, ci); if (typeof v === "number") pts.push([xAt(ci), ys(v)]); });
    if (!pts.length) return;
    const color = PALETTE[si % PALETTE.length];
    if (fill) {
      const d = `M${pts[0][0]},${base} ` + pts.map((p) => `L${p[0]},${p[1]}`).join(" ") + ` L${pts[pts.length - 1][0]},${base} Z`;
      svg.appendChild(svgEl(dom, "path", { d, fill: color, "fill-opacity": 0.15 }));
    }
    svg.appendChild(svgEl(dom, "path", { d: "M" + pts.map((p) => `${p[0]},${p[1]}`).join(" L"), fill: "none", stroke: color, "stroke-width": 2 }));
    pts.forEach((p) => svg.appendChild(svgEl(dom, "circle", { cx: p[0], cy: p[1], r: 3, fill: color })));
  });
}

function drawScatter(svg, dom, model, t) {
  // x is a numeric column (its text lives in cats); y is series[0]; size optional.
  const xs = t.cats.map((c) => parseFloat(c));
  const xmin = Math.min(...xs), xmax = Math.max(...xs) || xmin + 1;
  const ext = extent(t);
  axes(svg, dom, ext, t.cats);
  const ys = yScale(ext);
  const w = W - M.left - M.right;
  const xAt = (v) => M.left + ((v - xmin) / (xmax - xmin || 1)) * w;
  const s = t.series[0];
  const sizes = model.size ? model.dataset.numbers[model.size] : null;
  const smax = sizes ? Math.max(...sizes.filter((n) => typeof n === "number")) || 1 : 1;
  t.cats.forEach((c, ci) => {
    const v = t.get(s, ci);
    if (typeof v !== "number" || !Number.isFinite(xs[ci])) return;
    const r = sizes ? 3 + (sizes[ci] / smax) * 12 : 4;
    svg.appendChild(svgEl(dom, "circle", { cx: xAt(xs[ci]), cy: ys(v), r, fill: PALETTE[0], "fill-opacity": 0.6 }));
  });
}

function drawPie(svg, dom, t) {
  const s = t.series[0];
  const vals = t.cats.map((c, i) => Math.max(0, t.get(s, i) || 0));
  const total = vals.reduce((a, b) => a + b, 0) || 1;
  const cx = W / 2, cy = H / 2, r = Math.min(W, H) / 2 - 30;
  let a0 = -Math.PI / 2;
  vals.forEach((v, i) => {
    const a1 = a0 + (v / total) * Math.PI * 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const d = `M${cx},${cy} L${cx + r * Math.cos(a0)},${cy + r * Math.sin(a0)} A${r},${r} 0 ${large} 1 ${cx + r * Math.cos(a1)},${cy + r * Math.sin(a1)} Z`;
    svg.appendChild(svgEl(dom, "path", { d, fill: PALETTE[i % PALETTE.length] }));
    a0 = a1;
  });
}

function legend(dom, names) {
  const div = dom.createElement("div");
  div.className = "geml-chart-legend";
  names.forEach((n, i) => {
    const span = dom.createElement("span");
    const sw = dom.createElement("i");
    sw.style.background = PALETTE[i % PALETTE.length];
    span.appendChild(sw);
    span.appendChild(dom.createTextNode(n));
    div.appendChild(span);
  });
  return div;
}
