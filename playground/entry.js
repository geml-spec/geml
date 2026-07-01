// Playground bundle entry. Exposes the reference parser's pure core, the
// viewer's renderer, and (like the browser extension) KaTeX + Mermaid so math
// and diagrams render for real — all bundled, no CDN, no network.
import { parse } from "../geml-parser/dist/geml.js";
import { renderDocument, viewerDiagnostics } from "../geml-viewer/src/render.js";
import { upgradeMath, upgradeMermaid } from "../geml-viewer/src/upgrade.js";
import css from "../geml-viewer/src/geml.css";
import katex from "katex";
import katexCss from "katex/dist/katex.css";
import mermaid from "mermaid";

globalThis.GEML = {
  parse,
  renderDocument,
  viewerDiagnostics,
  css,
  katexCss,
  // Upgrade a freshly rendered root: KaTeX for math, Mermaid for diagrams.
  async enhance(root) {
    upgradeMath(root, katex);
    await upgradeMermaid(root, mermaid);
  },
};
