// Playground bundle entry. Exposes the reference parser's pure core, the
// viewer's renderer, and (like the browser extension) KaTeX + Mermaid so math
// and diagrams render for real — all bundled, no CDN, no network.
import { parse, unitSpans, sliceUnit } from "../geml-parser/dist/geml.js";
import { codeGraphWaves, codeGraphRuntime } from "../geml-parser/dist/render.js";
import { renderDocument, viewerDiagnostics } from "../integrations/geml-viewer/src/render.js";
import { expandTransclusions } from "../integrations/geml-viewer/src/transclude.js";
import { upgradeMath, upgradeMermaid, upgradeCodeGraph } from "../integrations/geml-viewer/src/upgrade.js";
import css from "../integrations/geml-viewer/src/geml.css";
import katex from "katex";
import katexCss from "katex/dist/katex.css";
import mermaid from "mermaid";

globalThis.GEML = {
  parse,
  // The span machinery the CLI addresses blocks with. Exposed so the page can
  // say what one block costs an agent without reimplementing the block scanner
  // in the browser — a second, divergent implementation of the one thing this
  // format is about would be the worst possible demo.
  unitSpans,
  sliceUnit,
  renderDocument,
  viewerDiagnostics,
  css,
  katexCss,
  // Upgrade a freshly rendered root: KaTeX for math, Mermaid for diagrams,
  // and geml-code-graph mounts (codemap documents fetched relative to the page).
  async enhance(root, opts = {}) {
    // Block transclusion first — borrowed content can carry math/diagrams, and
    // their placeholders must exist before the upgraders scan the subtree.
    // Same-origin only (the extension's rule: a page fetch could otherwise
    // reach any ACAO-open host). Callers that pass neither model nor
    // selfSource still degrade to links + notes, never a crash.
    const docUrl = opts.docUrl || (typeof location !== "undefined" ? location.href : "");
    if (docUrl) {
      await expandTransclusions(root, {
        parse,
        docUrl,
        children: opts.model?.children ?? (opts.selfSource ? parse(opts.selfSource).children : []),
        fetchText: async (url) => {
          try {
            if (new URL(url).origin !== new URL(docUrl).origin) return null;
            const res = await fetch(url, { cache: "no-cache" });
            if (!res.ok) return null;
            const ct = res.headers.get("content-type") || "";
            if (/\bhtml\b/i.test(ct)) return null; // an HTML page is never a GEML doc
            return await res.text();
          } catch { return null; }
        },
      });
    }
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
