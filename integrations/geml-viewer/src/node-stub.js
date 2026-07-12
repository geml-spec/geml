// The Node built-in stubs live with the parser package now (they are also
// served to browsers by `geml codemap serve` as /_dist/_node-stub.js); this
// file stays as the esbuild alias target and just forwards — one stub, three
// consumers (extension bundle, playground bundle, served pages).
export * from "../../../geml-parser/codemap/browser-stub.mjs";
export { default } from "../../../geml-parser/codemap/browser-stub.mjs";
