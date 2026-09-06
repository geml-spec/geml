// Re-export the reference parser's pure core for the browser bundle. We import
// the compiled output (geml-parser/dist) so esbuild does not need to resolve
// TypeScript or .js→.ts; build.mjs ensures geml-parser is built first. The
// Node-only CLI/history paths inside it are neutralized by build.mjs (alias
// node:* → node-stub, define process.argv → []).
export { parse } from "../../../geml-parser/dist/geml.js";
// GEP 0010 — WHAT a translation may touch is decided once, in the parser, and
// reused here. The browser supplies WHO does it (translate-browser.js).
export { translateBlocks, resolveTarget, glossaryFrom, HELD_BACK } from "../../../geml-parser/dist/geml.js";
// A rendered projection frozen as Markdown (snapshot.js) — the reference
// serializer, so a snapshot and `geml --to md` cannot disagree about anything but
// the translation the CLI could not perform.
export { gemlToMd } from "../../../geml-parser/dist/geml.js";
// And WHICH blocks an `=== embed` selects — one definition, shared, so the
// browser cannot disagree with the reference renderer about it. The viewer used
// to hand-copy this ("mirror geml-parser/src/render.ts", said the comment) and
// went on refusing prose addresses after the renderer learned them.
export { selectEmbed } from "../../../geml-parser/dist/geml.js";

// GEP 0011 coordinates. The parser answers one at PARSE time, but only when it
// was given a `resolveDoc`; a browser fetches asynchronously and cannot supply
// one, so a cross-document coordinate reaches the page unresolved and the
// transclusion pass has to answer it. Taken from the modules that define them —
// `geml.js` uses both but re-exports neither, and widening its surface is the
// change the viewer's esbuild stubs have to mirror.
export { parseCoordPath } from "../../../geml-parser/dist/selector.js";
export { projectCoord, metaView } from "../../../geml-parser/dist/coord.js";
// geml-code-graph (GEP-0003): the slice builder, the draw-time runtime AND
// the async wave builder are implemented ONCE in the reference renderer;
// browser consumers reuse them.
export { buildCodeGraph, codeGraphRuntime, codeGraphWaves } from "../../../geml-parser/dist/render.js";
