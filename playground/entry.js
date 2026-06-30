// Playground bundle entry. Exposes the reference parser's pure core and the
// viewer's pure renderer on `window.GEML`. No KaTeX/Mermaid: tables, geml-chart
// (inline SVG), and — the whole point — build-time diagnostics all work without
// any CDN. Math/mermaid degrade to labelled placeholders, which is fine here.
import { parse } from "../geml-parser/dist/geml.js";
import { renderDocument, viewerDiagnostics } from "../geml-viewer/src/render.js";
import css from "../geml-viewer/src/geml.css";

globalThis.GEML = { parse, renderDocument, viewerDiagnostics, css };
