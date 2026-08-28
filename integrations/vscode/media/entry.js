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
import { upgradeMath, upgradeMermaid } from "../../geml-viewer/src/upgrade.js";
import katex from "katex";
import mermaid from "mermaid";

globalThis.GEML = {
  parse,
  renderDocument,
  viewerDiagnostics,
  async enhance(root, opts = {}) {
    // Same-document projections only: `children` comes from the model, and
    // fetchText refuses everything, so a cross-document embed keeps its target
    // link plus a visible note instead of silently rendering blank.
    await expandTransclusions(root, {
      parse,
      docUrl: "geml-preview:/doc",
      children: opts.model?.children ?? [],
      fetchText: async () => null,
    });
    upgradeMath(root, katex);
    // A diagram carries its own colours, so the theme has to go in before it is
    // drawn — CSS variables cannot reach inside a finished SVG.
    await upgradeMermaid(root, mermaid, { theme: opts.theme });
  },
};
