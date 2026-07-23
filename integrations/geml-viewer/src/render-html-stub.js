// esbuild alias target for geml-parser's ./render-html.js in the browser bundle.
//
// render-html.js is the CLI-only standalone-HTML export (`geml render`). It is
// the sole source of remote-script string literals (cdn.jsdelivr KaTeX/Mermaid
// <script>/<link> tags) in the parser, and the Chrome Web Store scanner rejects
// bundles that reference remotely-hosted code. The viewer NEVER renders a
// standalone page — it uses its own src/render.js (renderDocument) — so it does
// not need renderHtml at all. It is pulled in only transitively: the viewer
// imports `parse` from the parser's dist/geml.js, whose retained-but-dead CLI
// dispatch (process.argv is [] in the bundle, so the entry guard is false at
// runtime) statically references renderHtml. Aliasing render-html.js to this
// no-op keeps that dead reference resolvable while keeping the CDN strings out
// of the bundle — the same neutralize-CLI-paths trick used for node:* imports.
export function renderHtml() {
  throw new Error("renderHtml is not available in the browser viewer bundle");
}
