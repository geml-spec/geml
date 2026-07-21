// The Node built-in stubs live with the parser package now (they are also
// served to browsers by `geml codemap serve` as /_dist/_node-stub.js); this
// file stays as the esbuild alias target and just forwards — one stub, three
// consumers (extension bundle, playground bundle, served pages).
export * from "../../../geml-parser/codemap/browser-stub.mjs";
export { default } from "../../../geml-parser/codemap/browser-stub.mjs";

// geml-parser/dist now statically imports `realpathSync` from node:fs (a recent
// bin-entrypoint fix). browser-stub.mjs predates that, so provide the shim here
// so the bundle's `node:fs` alias still resolves every named import. The CLI
// path that calls realpathSync never runs in a page (process.argv is [] in the
// bundle), so an identity no-op is the right, harmless behavior. This explicit
// local export also shadows any future star-exported copy without conflict.
export const realpathSync = (p) => p;
