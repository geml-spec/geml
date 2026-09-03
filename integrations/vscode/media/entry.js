// The webview bundle for the VS Code preview: the reference parser's pure core,
// the viewer's renderer, KaTeX and Mermaid — the same pieces the playground and
// the browser extension use, bundled by the same script that builds theirs.
//
// Deliberately narrower than the playground's entry. A webview has no origin to
// fetch sibling documents from, so cross-document transclusion and the
// code-graph mount are left out: they would degrade to a note either way, and
// pretending otherwise would mean shipping a fetch that can only fail. A
// SAME-document projection still expands, because that needs nothing but the
// model we already parsed.
//
// No stylesheets here either. The build copies geml.css and katex.css into this
// directory and the page links them, so KaTeX's `url(fonts/…)` resolves against
// the stylesheet's own URL and the pane's theme overrides land last in the
// cascade — neither of which is true for CSS injected from script.
import { parse } from "../../../geml-parser/dist/geml.js";
import { renderDocument, viewerDiagnostics } from "../../geml-viewer/src/render.js";
import { expandTransclusions } from "../../geml-viewer/src/transclude.js";
import { translateSliceWith } from "../../geml-viewer/src/translate-map.js";
import { snapshot } from "../../geml-viewer/src/snapshot.js";
import { upgradeMath, upgradeMermaid } from "../../geml-viewer/src/upgrade.js";
import katex from "katex";
import mermaid from "mermaid";

globalThis.GEML = {
  parse,
  renderDocument,
  viewerDiagnostics,
  // Freeze what the pane is showing. Only this side can: the CLI has no
  // translator, so `geml --to md` on a projection exports the source and says so.
  snapshot,
  async enhance(root, opts = {}) {
    // Cross-document embeds resolve out of the map the extension sends WITH the
    // document. This bundle has no filesystem — node:fs is aliased to a stub —
    // so the host reads the neighbours a document names and hands over their
    // text, keyed by the path the document wrote. Anything not in the map (a
    // neighbour's own embed, a file too large to ship, one that is gone) keeps
    // its target link plus the renderer's note, which is the truth.
    const docs = opts.docs || {};
    const lookup = (absUrl) => {
      const PREFIX = "geml-preview:/";
      const url = String(absUrl);
      const key = url.startsWith(PREFIX) ? url.slice(PREFIX.length) : url;
      if (Object.prototype.hasOwnProperty.call(docs, key)) return docs[key];
      let decoded = key;
      try { decoded = decodeURIComponent(key); } catch (e) { /* a bad escape is not a key */ }
      return Object.prototype.hasOwnProperty.call(docs, decoded) ? docs[decoded] : null;
    };
    // The host's translator, when it offered one. Without it expandTransclusions
    // falls back to Chrome's built-in Translator, which is not in Electron, and
    // a projection shows its source under a note.
    const translate = typeof opts.translate === "function" ? opts.translate : null;
    await expandTransclusions(root, {
      parse,
      docUrl: "geml-preview:/doc",
      children: opts.model?.children ?? [],
      fetchText: async (absUrl) => lookup(absUrl),
      // The pane's own post-render passes, again, for a section the reader
      // toggled between its translation and its source: that repaint happens
      // after enhance() ran its upgrades once, so without this the diagram and
      // the math come back as source text.
      onPaint: async (el) => {
        upgradeMath(el, katex);
        await upgradeMermaid(el, mermaid, { theme: opts.theme });
      },
      ...(translate
        ? { translateSlice: (blocks, target, opts) => translateSliceWith(translate, blocks, target, opts) }
        : {}),
    });
    upgradeMath(root, katex);
    // A diagram carries its own colours, so the theme has to go in before it is
    // drawn — CSS variables cannot reach inside a finished SVG.
    await upgradeMermaid(root, mermaid, { theme: opts.theme });
  },
};
