// Re-export the reference parser's pure core for the browser bundle. We import
// the compiled output (geml-parser/dist) so esbuild does not need to resolve
// TypeScript or .js→.ts; build.mjs ensures geml-parser is built first. The
// Node-only CLI/history paths inside it are neutralized by build.mjs (alias
// node:* → node-stub, define process.argv → []).
export { parse } from "../../geml-parser/dist/geml.js";
// geml-code-graph (GEP-0003): the slice builder, the draw-time runtime AND
// the async wave builder are implemented ONCE in the reference renderer;
// browser consumers reuse them.
export { buildCodeGraph, codeGraphRuntime, codeGraphWaves } from "../../geml-parser/dist/render.js";
