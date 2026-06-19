// Re-export the reference parser's pure core for the browser bundle. We import
// the compiled output (geml-parser/dist) so esbuild does not need to resolve
// TypeScript or .js→.ts; build.mjs ensures geml-parser is built first. The
// Node-only CLI/history paths inside it are neutralized by build.mjs (alias
// node:* → node-stub, define process.argv → []).
export { parse } from "../../geml-parser/dist/geml.js";
