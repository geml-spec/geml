// Playground bundle entry. Exposes the reference parser's pure core, the
// viewer's renderer, and (like the browser extension) KaTeX + Mermaid so math
// and diagrams render for real — all bundled, no CDN, no network.
import { parse } from "../geml-parser/dist/geml.js";
import { codeGraphWaves, codeGraphRuntime } from "../geml-parser/dist/render.js";
import { renderDocument, viewerDiagnostics } from "../geml-viewer/src/render.js";
import { upgradeMath, upgradeMermaid, upgradeCodeGraph } from "../geml-viewer/src/upgrade.js";
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
  // Upgrade a freshly rendered root: KaTeX for math, Mermaid for diagrams,
  // and geml-code-graph mounts (codemap documents fetched relative to the page).
  async enhance(root, opts = {}) {
    upgradeMath(root, katex);
    await upgradeMermaid(root, mermaid);
    await upgradeCodeGraph(root, {
      waves: codeGraphWaves,
      parse,
      runtime: codeGraphRuntime,
      selfName: opts.selfName,
      selfSource: opts.selfSource,
      fetchDoc: async (rel) => {
        try {
          const res = await fetch(rel, { cache: "no-cache" });
          return res.ok ? await res.text() : null;
        } catch { return null; }
      },
    });
  },
};
